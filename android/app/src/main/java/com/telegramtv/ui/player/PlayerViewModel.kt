package com.telegramtv.ui.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.annotation.OptIn
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackGroup
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.telegramtv.data.model.FileItem
import com.telegramtv.data.repository.AuthRepository
import com.telegramtv.data.repository.FilesRepository
import com.telegramtv.data.repository.SettingsRepository
import com.telegramtv.service.AudioPlaybackService
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/**
 * Audio/Subtitle track information.
 */
data class TrackInfo(
    val index: Int,
    val groupIndex: Int,
    val name: String,
    val language: String?,
    val isSelected: Boolean
)

/**
 * Subtitle size options.
 */
enum class SubtitleSize(val displayName: String, val scale: Float) {
    SMALL("Small", 0.7f),
    MEDIUM("Medium", 1.0f),
    LARGE("Large", 1.4f),
    EXTRA_LARGE("Extra Large", 1.8f)
}

/**
 * Parsed error information for user-friendly display.
 */
data class PlaybackError(
    val title: String,
    val description: String,
    val technicalDetails: String?,
    val canRetry: Boolean,
    val errorType: ErrorType
)

enum class ErrorType {
    CODEC_NOT_SUPPORTED,
    NETWORK_ERROR,
    AUTH_ERROR,
    FILE_NOT_FOUND,
    UNKNOWN
}

/**
 * Player UI state.
 */
data class PlayerUiState(
    val isLoading: Boolean = true,
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val currentPosition: Long = 0L,
    val bufferedPosition: Long = 0L,
    val duration: Long = 0L,
    val showControls: Boolean = true,
    val showSettings: Boolean = false,
    val file: FileItem? = null,
    val error: PlaybackError? = null,
    // Track info
    val audioTracks: List<TrackInfo> = emptyList(),
    val subtitleTracks: List<TrackInfo> = emptyList(),
    val subtitleSize: SubtitleSize = SubtitleSize.MEDIUM,
    val subtitlesEnabled: Boolean = true,
    // Enhanced seek/playback
    val seekSpeed: Int = 10_000,
    val showSeekIndicator: Boolean = false,
    val seekIndicatorText: String = "",
    val seekIndicatorForward: Boolean = true,
    val showJumpDialog: Boolean = false,
    val toggleResizeMode: Int = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT,
    val videoScale: Float = 1.0f,
    val videoOffsetX: Float = 0f,
    val videoOffsetY: Float = 0f,
    val orientationLock: Int = 0, // 0=Auto, 1=Landscape, 2=Portrait
    val playbackSpeed: Float = 1.0f,
    val isAudioFile: Boolean = false
)

/**
 * ViewModel for the player screen.
 */
@HiltViewModel
class PlayerViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    @ApplicationContext private val context: Context,
    val exoPlayer: ExoPlayer,
    private val httpDataSourceFactory: DefaultHttpDataSource.Factory,
    private val filesRepository: FilesRepository,
    private val settingsRepository: SettingsRepository,
    private val authRepository: AuthRepository
) : ViewModel() {
// ... (existing code) ...

    /**
     * Set resize mode explicitly.
     */
    fun setResizeMode(mode: Int) {
        _uiState.value = _uiState.value.copy(toggleResizeMode = mode)
    }

    /**
     * Set custom video scale (zoom).
     */
    fun setVideoScale(scale: Float) {
        _uiState.value = _uiState.value.copy(videoScale = scale.coerceIn(0.5f, 5.0f))
    }

    /**
     * Set video pan offsets.
     */
    fun setVideoPan(x: Float, y: Float) {
        _uiState.value = _uiState.value.copy(videoOffsetX = x, videoOffsetY = y)
    }

    /**
     * Set orientation lock.
     * 0 = Auto/Sensor
     * 1 = Landscape
     * 2 = Portrait
     */
    fun setOrientationLock(mode: Int) {
        _uiState.value = _uiState.value.copy(orientationLock = mode)
    }

    /**
     * Cycle orientation lock: Auto -> Landscape -> Portrait
     */
    fun cycleOrientation() {
        val current = _uiState.value.orientationLock
        val next = (current + 1) % 3
        _uiState.value = _uiState.value.copy(orientationLock = next)
    }



    /**
     * Update pan offset.
     */
    fun updatePan(deltaX: Float, deltaY: Float) {
        val currentX = _uiState.value.videoOffsetX
        val currentY = _uiState.value.videoOffsetY
        _uiState.value = _uiState.value.copy(
            videoOffsetX = currentX + deltaX,
            videoOffsetY = currentY + deltaY
        )
    }

    /**
     * Cycle resize mode: FIT -> FILL -> ZOOM
     */


    /**
     * Cycle resize mode: FIT -> FILL -> ZOOM
     */
    fun cycleResizeMode() {
        val current = _uiState.value.toggleResizeMode
        val next = when (current) {
            androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FILL
            androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FILL -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            else -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
        _uiState.value = _uiState.value.copy(toggleResizeMode = next, videoScale = 1.0f)
    }

    private val fileId: Int = savedStateHandle.get<Int>("fileId") ?: 0

    private val _uiState = MutableStateFlow(PlayerUiState())
    val uiState: StateFlow<PlayerUiState> = _uiState.asStateFlow()

    private var progressSaveJob: kotlinx.coroutines.Job? = null
    private var controlHideJob: kotlinx.coroutines.Job? = null
    private var seekIndicatorJob: kotlinx.coroutines.Job? = null
    private var seekAccelJob: kotlinx.coroutines.Job? = null
    private var resumePosition: Long = savedStateHandle.get<Long>("startPosition") ?: 0L
    private var consecutiveSeekCount: Int = 0
    private var lastSeekTime: Long = 0L

    init {
        setupPlayerListener()
        loadAndPlay()
        startProgressTracking()
    }

    private var retryCount = 0
    private val maxRetries = 3

    /**
     * Set up ExoPlayer event listener.
     */
    @OptIn(UnstableApi::class)
    private fun setupPlayerListener() {
        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> {
                        _uiState.value = _uiState.value.copy(isBuffering = true)
                    }
                    Player.STATE_READY -> {
                        retryCount = 0 // Reset retry count on successful play
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            isBuffering = false,
                            duration = exoPlayer.duration
                        )
                        updateTracks()
                    }
                    Player.STATE_ENDED -> {
                        _uiState.value = _uiState.value.copy(
                            isPlaying = false,
                            showControls = true
                        )
                        saveProgress(completed = true)
                    }
                    Player.STATE_IDLE -> {
                        // Idle
                    }
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _uiState.value = _uiState.value.copy(isPlaying = isPlaying)
                if (isPlaying) {
                    scheduleControlsHide()
                }
            }

            override fun onTracksChanged(tracks: Tracks) {
                updateTracks()
            }

            override fun onPlayerError(error: PlaybackException) {
                // Save progress immediately before transitioning to error state
                saveProgress()

                if (retryCount < maxRetries) {
                    retryCount++
                    retry()
                } else {
                    val parsedError = parsePlaybackError(error)
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = parsedError
                    )
                }
            }
        })
    }

    /**
     * Parse playback error into user-friendly message.
     */
    @OptIn(UnstableApi::class)
    private fun parsePlaybackError(error: PlaybackException): PlaybackError {
        val message = error.message ?: ""
        val cause = error.cause?.message ?: ""
        val fullDetails = "$message\n$cause"

        return when {
            // Codec/Format not supported
            message.contains("NO_EXCEEDS_CAPABILITIES", ignoreCase = true) ||
            message.contains("Decoder init failed", ignoreCase = true) ||
            message.contains("codec", ignoreCase = true) ||
            cause.contains("NO_EXCEEDS_CAPABILITIES", ignoreCase = true) -> {
                val codecInfo = extractCodecInfo(message + cause)
                PlaybackError(
                    title = "Format Not Supported",
                    description = "This video uses $codecInfo which your device cannot play. " +
                            "Try a different video or use a device with better codec support.",
                    technicalDetails = fullDetails,
                    canRetry = false,
                    errorType = ErrorType.CODEC_NOT_SUPPORTED
                )
            }
            // Network errors
            error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
            error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ||
            message.contains("Unable to connect", ignoreCase = true) ||
            message.contains("timeout", ignoreCase = true) -> {
                PlaybackError(
                    title = "Connection Error",
                    description = "Could not connect to the server. Please check your internet connection and try again.",
                    technicalDetails = fullDetails,
                    canRetry = true,
                    errorType = ErrorType.NETWORK_ERROR
                )
            }
            // Auth errors
            message.contains("401", ignoreCase = true) ||
            message.contains("403", ignoreCase = true) ||
            message.contains("Unauthorized", ignoreCase = true) -> {
                PlaybackError(
                    title = "Authentication Error",
                    description = "Your session has expired. Please go back and try again, or re-login.",
                    technicalDetails = fullDetails,
                    canRetry = true,
                    errorType = ErrorType.AUTH_ERROR
                )
            }
            // File not found
            message.contains("404", ignoreCase = true) ||
            message.contains("not found", ignoreCase = true) -> {
                PlaybackError(
                    title = "File Not Found",
                    description = "This file is no longer available or may have been deleted.",
                    technicalDetails = fullDetails,
                    canRetry = false,
                    errorType = ErrorType.FILE_NOT_FOUND
                )
            }
            // Generic error
            else -> {
                PlaybackError(
                    title = "Playback Error",
                    description = "An error occurred while playing this file.",
                    technicalDetails = fullDetails,
                    canRetry = true,
                    errorType = ErrorType.UNKNOWN
                )
            }
        }
    }

    /**
     * Extract codec info from error message.
     */
    private fun extractCodecInfo(message: String): String {
        // Try to extract codec type from error message
        return when {
            message.contains("hevc", ignoreCase = true) || 
            message.contains("hvc1", ignoreCase = true) ||
            message.contains("x265", ignoreCase = true) -> {
                if (message.contains("10bit", ignoreCase = true) || 
                    message.contains("10-bit", ignoreCase = true)) {
                    "HEVC 10-bit (HDR)"
                } else {
                    "HEVC/H.265"
                }
            }
            message.contains("av1", ignoreCase = true) -> "AV1"
            message.contains("vp9", ignoreCase = true) -> "VP9"
            message.contains("dolby", ignoreCase = true) -> "Dolby Vision"
            else -> "an advanced video format"
        }
    }

    /**
     * Update available audio and subtitle tracks.
     */
    @OptIn(UnstableApi::class)
    private fun updateTracks() {
        val tracks = exoPlayer.currentTracks
        val audioTracks = mutableListOf<TrackInfo>()
        val subtitleTracks = mutableListOf<TrackInfo>()

        tracks.groups.forEachIndexed { groupIndex, group ->
            val trackGroup = group.mediaTrackGroup
            
            for (trackIndex in 0 until trackGroup.length) {
                val format = trackGroup.getFormat(trackIndex)
                val isSelected = group.isTrackSelected(trackIndex)
                
                when {
                    format.sampleMimeType?.startsWith("audio/") == true || 
                    group.type == C.TRACK_TYPE_AUDIO -> {
                        audioTracks.add(TrackInfo(
                            index = trackIndex,
                            groupIndex = groupIndex,
                            name = getTrackName(format, audioTracks.size + 1, "Audio"),
                            language = format.language,
                            isSelected = isSelected
                        ))
                    }
                    format.sampleMimeType?.startsWith("text/") == true ||
                    group.type == C.TRACK_TYPE_TEXT -> {
                        subtitleTracks.add(TrackInfo(
                            index = trackIndex,
                            groupIndex = groupIndex,
                            name = getTrackName(format, subtitleTracks.size + 1, "Subtitle"),
                            language = format.language,
                            isSelected = isSelected
                        ))
                    }
                }
            }
        }

        _uiState.value = _uiState.value.copy(
            audioTracks = audioTracks,
            subtitleTracks = subtitleTracks
        )
    }

    /**
     * Generate user-friendly track name.
     */
    @OptIn(UnstableApi::class)
    private fun getTrackName(format: Format, index: Int, type: String): String {
        val language = format.language?.let { lang ->
            java.util.Locale(lang).displayLanguage.takeIf { it.isNotBlank() }
        }
        val label = format.label?.takeIf { it.isNotBlank() }
        
        return when {
            label != null -> label
            language != null -> language
            else -> "$type Track $index"
        }
    }

    /**
     * Select an audio track.
     */
    @OptIn(UnstableApi::class)
    fun selectAudioTrack(trackInfo: TrackInfo) {
        val tracks = exoPlayer.currentTracks
        val group = tracks.groups.getOrNull(trackInfo.groupIndex) ?: return
        val trackGroup = group.mediaTrackGroup

        exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
            .buildUpon()
            .setOverrideForType(
                TrackSelectionOverride(trackGroup, listOf(trackInfo.index))
            )
            .build()
    }

    /**
     * Select a subtitle track, or disable subtitles.
     */
    @OptIn(UnstableApi::class)
    fun selectSubtitleTrack(trackInfo: TrackInfo?) {
        if (trackInfo == null) {
            // Disable all text tracks
            exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
                .buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                .build()
            _uiState.value = _uiState.value.copy(subtitlesEnabled = false)
        } else {
            val tracks = exoPlayer.currentTracks
            val group = tracks.groups.getOrNull(trackInfo.groupIndex) ?: return
            val trackGroup = group.mediaTrackGroup

            exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
                .buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(
                    TrackSelectionOverride(trackGroup, listOf(trackInfo.index))
                )
                .build()
            _uiState.value = _uiState.value.copy(subtitlesEnabled = true)
        }
    }

    /**
     * Set subtitle size.
     */
    fun setSubtitleSize(size: SubtitleSize) {
        _uiState.value = _uiState.value.copy(subtitleSize = size)
        // Note: Actual subtitle styling would need CaptionStyleCompat applied to PlayerView
    }

    /**
     * Toggle settings panel visibility.
     */
    fun toggleSettings() {
        _uiState.value = _uiState.value.copy(
            showSettings = !_uiState.value.showSettings,
            showControls = true
        )
        if (_uiState.value.showSettings) {
            controlHideJob?.cancel()
        } else {
            scheduleControlsHide()
        }
    }

    /**
     * Hide settings panel.
     */
    fun hideSettings() {
        _uiState.value = _uiState.value.copy(showSettings = false)
        scheduleControlsHide()
    }

    /**
     * Load media and start playback.
     * Checks for a local file in Downloads first; falls back to streaming.
     */
    @OptIn(UnstableApi::class)
    fun loadAndPlay() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            // Load file info
            val fileResult = filesRepository.getFile(fileId)
            fileResult.fold(
                onSuccess = { file ->
                    _uiState.value = _uiState.value.copy(
                        file = file,
                        isAudioFile = file.isAudio
                    )

                    // Fetch resume position from backend if not already set
                    if (resumePosition <= 0) {
                        filesRepository.getWatchProgress(fileId).onSuccess { progress ->
                            progress?.let {
                                resumePosition = it.position.toLong() * 1000L
                            }
                        }
                    }

                    // Check if a local copy exists in Downloads
                    val downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS
                    )
                    val localFile = File(downloadsDir, file.fileName)
                    val useLocalFile = localFile.exists() && localFile.length() > 0

                    val mediaItem: MediaItem
                    val mediaSourceFactory: DefaultMediaSourceFactory

                    if (useLocalFile) {
                        // ── Play from local file ──
                        val localUri = Uri.fromFile(localFile)
                        mediaItem = MediaItem.Builder()
                            .setUri(localUri)
                            .setMediaId(fileId.toString())
                            .build()
                        // DefaultDataSource.Factory handles both file:// and http:// URIs
                        mediaSourceFactory = DefaultMediaSourceFactory(
                            DefaultDataSource.Factory(context, httpDataSourceFactory)
                        )
                    } else {
                        // ── Stream from server ──
                        val serverUrl = settingsRepository.getServerUrl()
                        val token = authRepository.getAccessToken()

                        // Configure HTTP headers with auth
                        httpDataSourceFactory.setDefaultRequestProperties(
                            if (token != null) {
                                mapOf("Authorization" to "Bearer $token")
                            } else {
                                emptyMap()
                            }
                        )

                        val streamUrl = "$serverUrl/api/stream/$fileId"
                        mediaItem = MediaItem.Builder()
                            .setUri(streamUrl)
                            .setMediaId(fileId.toString())
                            .build()
                        httpDataSourceFactory.setAllowCrossProtocolRedirects(true)
                        mediaSourceFactory = DefaultMediaSourceFactory(httpDataSourceFactory)
                    }

                    // Load and prepare
                    exoPlayer.setMediaSource(mediaSourceFactory.createMediaSource(mediaItem))
                    exoPlayer.prepare()

                    // Seek to resume position if provided
                    if (resumePosition > 0) {
                        exoPlayer.seekTo(resumePosition)
                    }

                    exoPlayer.playWhenReady = true
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = PlaybackError(
                            title = "Failed to Load",
                            description = e.message ?: "Could not load file information",
                            technicalDetails = null,
                            canRetry = true,
                            errorType = ErrorType.UNKNOWN
                        )
                    )
                }
            )
        }
    }

    /**
     * Retry playback after error.
     */
    fun retry() {
        // Save current position before clearing so we can resume from here
        resumePosition = exoPlayer.currentPosition.coerceAtLeast(0)
        saveProgress()
        exoPlayer.stop()
        exoPlayer.clearMediaItems()
        loadAndPlay()
    }

    /**
     * Set resume position before loading.
     */
    fun setResumePosition(position: Long) {
        resumePosition = position
    }

    /**
     * Toggle play/pause.
     */
    fun togglePlayback() {
        if (exoPlayer.isPlaying) {
            exoPlayer.pause()
            saveProgress()
        } else {
            exoPlayer.play()
        }
        showControls()
    }

    /**
     * Open the current video in an external player.
     */
    fun openInExternalPlayer(context: Context) {
        viewModelScope.launch {
            val file = _uiState.value.file ?: return@launch
            val serverUrl = settingsRepository.getServerUrl()
            
            // Get public link instead of tokenized one
            val publicLinkResult = filesRepository.getPublicLink(file.id, serverUrl)
            
            val streamUrl = publicLinkResult.getOrElse {
                // Fallback to tokenized if public link fails
                "$serverUrl/api/stream/${file.id}"
            }
            
            try {
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(Uri.parse(streamUrl), "video/*")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    /**
     * Play.
     */
    fun play() {
        exoPlayer.play()
    }

    /**
     * Pause.
     */
    fun pause() {
        exoPlayer.pause()
    }

    /**
     * Seek to position in milliseconds.
     */
    fun seekTo(positionMs: Long) {
        val clampedPosition = positionMs.coerceIn(0, exoPlayer.duration)
        exoPlayer.seekTo(clampedPosition)
        updatePosition()
        showControls()
    }

    /**
     * Optimistically update current position (for scrubbing).
     */
    fun updateCurrentPosition(position: Long) {
        _uiState.value = _uiState.value.copy(currentPosition = position)
    }

    /**
     * Commit seek after scrubbing.
     */
    fun onSeekEnd() {
        val target = _uiState.value.currentPosition
        seekTo(target)
    }

    /**
     * Calculate accelerating seek amount based on consecutive seek presses.
     * Pattern: 10s → 30s → 1min → 2min → 5min
     */
    private fun getAcceleratedSeekMs(): Long {
        val now = System.currentTimeMillis()
        if (now - lastSeekTime > 1500) {
            consecutiveSeekCount = 0
        }
        lastSeekTime = now
        consecutiveSeekCount++

        val seekMs = when {
            consecutiveSeekCount <= 3 -> 10_000L
            consecutiveSeekCount <= 6 -> 30_000L
            consecutiveSeekCount <= 10 -> 60_000L
            consecutiveSeekCount <= 15 -> 120_000L
            else -> 300_000L
        }
        _uiState.value = _uiState.value.copy(seekSpeed = seekMs.toInt())
        return seekMs
    }

    /**
     * Seek backward with acceleration.
     */
    fun seekBackward() {
        val seekMs = getAcceleratedSeekMs()
        val newPos = exoPlayer.currentPosition - seekMs
        seekTo(newPos)
        showSeekIndicator(seekMs, false)
    }

    /**
     * Seek forward with acceleration.
     */
    fun seekForward() {
        val seekMs = getAcceleratedSeekMs()
        val newPos = exoPlayer.currentPosition + seekMs
        seekTo(newPos)
        showSeekIndicator(seekMs, true)
    }

    /**
     * Show seek indicator overlay with auto-hide.
     */
    private fun showSeekIndicator(seekMs: Long, isForward: Boolean) {
        val text = formatSeekAmount(seekMs)
        _uiState.value = _uiState.value.copy(
            showSeekIndicator = true,
            seekIndicatorText = if (isForward) "+$text" else "-$text",
            seekIndicatorForward = isForward
        )
        seekIndicatorJob?.cancel()
        seekIndicatorJob = viewModelScope.launch {
            delay(800)
            _uiState.value = _uiState.value.copy(showSeekIndicator = false)
        }
    }

    /**
     * Format seek amount for display.
     */
    private fun formatSeekAmount(ms: Long): String {
        val totalSeconds = ms / 1000
        return when {
            totalSeconds >= 60 -> "${totalSeconds / 60}min"
            else -> "${totalSeconds}s"
        }
    }

    /**
     * Jump to a percentage of the video (0-9 keys = 0%-90%).
     */
    fun jumpToPercent(percent: Int) {
        val dur = exoPlayer.duration
        if (dur <= 0) return
        val target = (dur * percent / 100L)
        seekTo(target)
        showControls()
        _uiState.value = _uiState.value.copy(
            showSeekIndicator = true,
            seekIndicatorText = "${percent}%",
            seekIndicatorForward = true
        )
        seekIndicatorJob?.cancel()
        seekIndicatorJob = viewModelScope.launch {
            delay(1200)
            _uiState.value = _uiState.value.copy(showSeekIndicator = false)
        }
    }

    /**
     * Jump to exact timestamp.
     */
    fun jumpToTimestamp(hours: Int, minutes: Int, seconds: Int) {
        val posMs = ((hours * 3600L) + (minutes * 60L) + seconds) * 1000L
        seekTo(posMs)
        _uiState.value = _uiState.value.copy(showJumpDialog = false)
    }

    /**
     * Toggle jump-to-position dialog.
     */
    fun toggleJumpDialog() {
        _uiState.value = _uiState.value.copy(
            showJumpDialog = !_uiState.value.showJumpDialog
        )
        if (_uiState.value.showJumpDialog) {
            controlHideJob?.cancel()
        }
    }

    /**
     * Set playback speed.
     */
    fun setPlaybackSpeed(speed: Float) {
        exoPlayer.setPlaybackSpeed(speed)
        _uiState.value = _uiState.value.copy(playbackSpeed = speed)
    }

    /**
     * Cycle through playback speeds.
     */
    fun cyclePlaybackSpeed() {
        val speeds = listOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
        val currentIndex = speeds.indexOf(_uiState.value.playbackSpeed)
        val nextIndex = if (currentIndex < 0 || currentIndex >= speeds.size - 1) 0 else currentIndex + 1
        setPlaybackSpeed(speeds[nextIndex])
    }



    /**
     * Show controls and schedule auto-hide.
     */
    fun showControls() {
        _uiState.value = _uiState.value.copy(showControls = true)
        if (!_uiState.value.showSettings) {
            scheduleControlsHide()
        }
    }

    /**
     * Hide controls.
     */
    fun hideControls() {
        if (_uiState.value.isPlaying && !_uiState.value.showSettings) {
            _uiState.value = _uiState.value.copy(showControls = false)
        }
    }

    /**
     * Schedule controls to hide after delay.
     */
    private fun scheduleControlsHide() {
        controlHideJob?.cancel()
        controlHideJob = viewModelScope.launch {
            delay(5000)
            if (_uiState.value.isPlaying && !_uiState.value.showSettings) {
                _uiState.value = _uiState.value.copy(showControls = false)
            }
        }
    }

    /**
     * Start tracking playback progress for position updates.
     */
    private fun startProgressTracking() {
        viewModelScope.launch {
            var ticks = 0
            while (true) {
                updatePosition()
                
                if (exoPlayer.isPlaying) {
                    ticks++
                    if (ticks >= 15) {
                        saveProgress(completed = false)
                        ticks = 0
                    }
                } else {
                    ticks = 0
                }
                
                delay(1000)
            }
        }
    }

    /**
     * Update current position in state.
     */
    private fun updatePosition() {
        _uiState.value = _uiState.value.copy(
            currentPosition = exoPlayer.currentPosition,
            bufferedPosition = exoPlayer.bufferedPosition,
            duration = exoPlayer.duration.coerceAtLeast(0)
        )
    }

    /**
     * Save current playback progress to backend.
     */
    fun saveProgress(completed: Boolean = false) {
        val position = (exoPlayer.currentPosition / 1000).toInt()
        val duration = (exoPlayer.duration / 1000).toInt().takeIf { it > 0 }

        // Don't save if position is 0 (initial load failure or not yet started)
        if (position <= 0 && !completed) return

        progressSaveJob?.cancel()
        progressSaveJob = viewModelScope.launch {
            filesRepository.updateWatchProgress(
                fileId = fileId,
                position = position,
                duration = duration,
                completed = completed
            )
        }
    }

    /**
     * Called when leaving the player - save progress.
     * For audio files, start background playback instead of pausing.
     */
    fun onLeavePlayer() {
        saveProgress()
        if (_uiState.value.isAudioFile && exoPlayer.isPlaying) {
            startBackgroundAudio()
        } else {
            exoPlayer.pause()
        }
    }

    private var isBackgroundAudioActive = false

    /**
     * Start the background audio playback service.
     */
    fun startBackgroundAudio() {
        isBackgroundAudioActive = true
        val intent = Intent(context, AudioPlaybackService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    /**
     * Stop the background audio playback service.
     */
    fun stopBackgroundAudio() {
        isBackgroundAudioActive = false
        val intent = Intent(context, AudioPlaybackService::class.java)
        context.stopService(intent)
    }

    override fun onCleared() {
        super.onCleared()
        saveProgress()
        if (!isBackgroundAudioActive) {
            // Only stop player if NOT handing off to background service
            exoPlayer.stop()
            exoPlayer.clearMediaItems()
        }
    }

}
