package com.telegramtv.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape

private val DarkColorScheme = darkColorScheme(
    primary = TVPrimary,
    onPrimary = Color.White,
    primaryContainer = TVPrimaryVariant,
    onPrimaryContainer = Color.White,
    secondary = TVSecondary,
    onSecondary = Color.Black,
    secondaryContainer = TVSecondary.copy(alpha = 0.3f),
    onSecondaryContainer = TVSecondary,
    background = TVBackground,
    onBackground = TVTextPrimary,
    surface = TVSurface,
    onSurface = TVTextPrimary,
    surfaceVariant = TVSurfaceVariant,
    onSurfaceVariant = TVTextSecondary,
    error = TVError,
    onError = Color.Black,
)

// TV apps typically use dark theme only
private val LightColorScheme = DarkColorScheme

@Composable
fun TelePlayTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    // Always use dark theme for TV
    val colorScheme = DarkColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        shapes = Shapes,
        typography = Typography,
        content = content
    )
}

// Modern Material 3 Expressive Color System
private val MobileColorScheme = darkColorScheme(
    primary = Color(0xFFD0BCFF), // Violet
    onPrimary = Color(0xFF381E72),
    primaryContainer = Color(0xFF4F378B),
    onPrimaryContainer = Color(0xFFEADDFF),

    secondary = Color(0xFFCCC2DC), // Muted Purple
    onSecondary = Color(0xFF332D41),
    secondaryContainer = Color(0xFF4A4458),
    onSecondaryContainer = Color(0xFFE8DEF8),

    tertiary = Color(0xFFEFB8C8), // Soft Pink
    onTertiary = Color(0xFF492532),

    background = Color(0xFF1C1B1F), // Deeper Material Dark
    onBackground = Color(0xFFE6E1E5),

    surface = Color(0xFF1C1B1F),
    onSurface = Color(0xFFE6E1E5),
    surfaceVariant = Color(0xFF49454F),
    onSurfaceVariant = Color(0xFFCAC4D0),

    error = Color(0xFFF2B8B5),
    onError = Color(0xFF601410),
)

// Material 3 Expressive Shapes
val ExpressiveShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp), 
    extraLarge = RoundedCornerShape(32.dp)
)

@Composable
fun TelePlayMobileTheme(
    content: @Composable () -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val view = androidx.compose.ui.platform.LocalView.current
    
    val colorScheme = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
        androidx.compose.material3.dynamicDarkColorScheme(context)
    } else {
        MobileColorScheme
    }

    if (!view.isInEditMode) {
        androidx.compose.runtime.SideEffect {
            val window = (view.context as android.app.Activity).window
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            androidx.core.view.WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
            androidx.core.view.WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = false
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        shapes = ExpressiveShapes,
        typography = Typography,
        content = content
    )
}

@Composable
fun GlassmorphismSurface(
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = MaterialTheme.shapes.large,
    borderColor: Color? = null,
    content: @Composable () -> Unit
) {
    // Basic Glassmorphism simulation for Android < 12 (Blur is expensive/API dependent)
    androidx.compose.material3.Surface(
        modifier = modifier,
        color = MobileSurface.copy(alpha = 0.75f), // High transparency
        border = androidx.compose.foundation.BorderStroke(1.dp, if (borderColor != null) {
            androidx.compose.ui.graphics.Brush.linearGradient(listOf(borderColor, borderColor))
        } else {
            androidx.compose.ui.graphics.Brush.linearGradient(
                colors = listOf(
                    Color.White.copy(alpha = 0.15f),
                    Color.Transparent
                )
            )
        }),
        shape = shape,
        content = content
    )
}
