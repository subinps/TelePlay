"""
FastAPI main application with Telegram MTProto client lifecycle.

Production features:
- Split health checks: /health (liveness) + /health/ready (readiness with DB/Telegram)
- Supervised sync task with proper cancellation on shutdown
- Fatal Telegram client startup failures (app won't report ready if bot can't connect)
- Security headers on all non-streaming routes
- CORS configured for production origins
- No internal cache stats exposed publicly
"""

import asyncio
import logging
from contextlib import asynccontextmanager

import psutil
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .config import get_settings
from .database import async_session, init_db
from .routers import auth_router, files_router, playback, streaming_router, tv_router
from .telegram import start_all_clients, stop_all_clients, tg_client

# Make application logs visible (uvicorn only configures its own loggers by default).
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logging.getLogger("pyrogram").setLevel(logging.WARNING)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)
settings = get_settings()

# Rate limiter for legacy routes (new routes use app.ratelimit module)
limiter = Limiter(key_func=get_remote_address)

# Track the sync task so we can cancel it on shutdown
_sync_task: asyncio.Task | None = None


async def _supervised_sync():
    """
    Run sync_with_channel with proper error handling and logging.
    This task is supervised - errors are logged but don't crash the app.
    """
    from .bot import sync_with_channel
    
    try:
        logger.info("Starting background sync with Telegram storage channel...")
        removed = await sync_with_channel()
        logger.info("Background sync complete: removed %d orphaned files", removed)
    except Exception as e:
        # Log but don't crash - sync is best-effort
        logger.error("Background sync failed: %s", e, exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - start/stop Telegram clients, init DB, supervise sync."""
    global _sync_task
    
    logger.info("Starting Media Hub Backend...")
    
    # 1. Initialize database
    await init_db()
    logger.info("Database initialized")
    
    # 2. Start Telegram clients (main client failure is FATAL - raises exception)
    #    Helper client failures are logged but don't crash the app
    try:
        await start_all_clients()
        logger.info("Telegram clients started")
    except Exception as e:
        logger.critical("Failed to start Telegram main client: %s", e)
        raise  # Fatal - app won't start without main bot
    
    # 3. Start supervised sync task (best-effort, errors logged but not fatal)
    _sync_task = asyncio.create_task(_supervised_sync(), name="sync_task")
    
    yield
    
    # Shutdown sequence
    logger.info("Shutting down...")
    
    # 4. Cancel sync task if running
    if _sync_task and not _sync_task.done():
        logger.info("Cancelling background sync task...")
        _sync_task.cancel()
        try:
            await asyncio.wait_for(_sync_task, timeout=5.0)
        except asyncio.CancelledError:
            logger.info("Sync task cancelled")
        except asyncio.TimeoutError:
            logger.warning("Sync task did not cancel within 5 seconds")
        except Exception as e:
            logger.warning("Error during sync task cancellation: %s", e)
    
    # 5. Stop Telegram clients
    await stop_all_clients()
    logger.info("Telegram clients stopped")
    
    logger.info("Shutdown complete")


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(
    title="Media Hub API",
    description="Private Telegram media streaming",
    version="1.0.0",
    lifespan=lifespan,
)

# Attach rate limiter to app state (for legacy routes)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ============================================================================
# CORS Middleware
# ============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "Range", "X-Device-Id"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)


# ============================================================================
# Security Headers Middleware
# ============================================================================

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    """
    Add security headers to all responses EXCEPT streaming routes.
    
    Streaming routes are excluded because BaseHTTPMiddleware adds a copy hop
    per chunk and interferes with cancellation when the browser seeks.
    """
    # Never wrap the media stream
    if request.url.path.startswith("/api/stream/"):
        return await call_next(request)
    
    response = await call_next(request)
    
    # Security headers
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    
    return response


# ============================================================================
# Router Registration
# ============================================================================

app.include_router(auth_router, prefix="/api")
app.include_router(files_router, prefix="/api")
app.include_router(streaming_router, prefix="/api")
app.include_router(tv_router, prefix="/api")
app.include_router(playback.router, prefix="/api")

# Note: folders_router is NOT included (folders router was deleted in File 3)


# ============================================================================
# Health Check Endpoints
# ============================================================================

@app.get("/health")
async def health_liveness():
    """
    Liveness probe - basic process health.
    
    Returns 200 if the process is running. Does NOT check database or Telegram
    connectivity. Use /health/ready for full readiness checks.
    
    This endpoint is safe to call frequently by load balancers and orchestrators.
    """
    mem = psutil.virtual_memory()
    return {
        "status": "alive",
        "memory": {
            "total_mb": mem.total // (1024 * 1024),
            "used_mb": mem.used // (1024 * 1024),
            "percent": mem.percent,
        },
    }


@app.get("/health/ready")
async def health_readiness():
    """
    Readiness probe - checks database and Telegram connectivity.
    
    Returns 200 only if:
    - Database is reachable and can execute queries
    - Telegram main client is connected and authorized
    
    Returns 503 if any required dependency is unavailable.
    
    This endpoint should NOT be called frequently (e.g., every 5 seconds) as it
    performs actual database queries and Telegram API calls. Use /health for
    frequent liveness checks.
    """
    checks = {
        "database": False,
        "telegram": False,
    }
    
    # Check database connectivity
    try:
        async with async_session() as db:
            # Simple query to verify DB is reachable
            result = await db.execute(
                __import__("sqlalchemy").text("SELECT 1")
            )
            checks["database"] = result.scalar() == 1
    except Exception as e:
        logger.warning("Database health check failed: %s", e)
        checks["database"] = False
    
    # Check Telegram main client connectivity
    try:
        if tg_client is None:
            checks["telegram"] = False
        else:
            # Try to get bot info - this verifies the client is connected
            me = await tg_client.get_me()
            checks["telegram"] = me is not None
    except Exception as e:
        logger.warning("Telegram health check failed: %s", e)
        checks["telegram"] = False
    
    # Determine overall status
    all_healthy = all(checks.values())
    status_code = 200 if all_healthy else 503
    
    response = {
        "status": "ready" if all_healthy else "not_ready",
        "checks": checks,
    }
    
    # Return with appropriate status code
    from fastapi.responses import JSONResponse
    return JSONResponse(content=response, status_code=status_code)


# ============================================================================
# Development Server
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    logger.info("Starting development server...")
    uvicorn.run(
        "app.main:app",
        host=settings.server_host,
        port=settings.server_port,
        reload=True,
        log_level="info",
    )