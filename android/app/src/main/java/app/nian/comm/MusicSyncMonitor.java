package app.nian.comm;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;

/**
 * 音乐同步监听器 - 读取通知栏MediaSession
 * 需要用户授予通知监听权限
 */
public class MusicSyncMonitor {
    private static final String TAG = "MusicSyncMonitor";
    private static final long POLL_INTERVAL_MS = 2000; // 2秒轮询一次
    
    private final Activity activity;
    private final MusicSyncCallback callback;
    private final Handler handler;
    private final MediaSessionManager sessionManager;
    private MediaController currentController;
    private MusicTrackInfo lastTrack;
    private int songIndex = 0;
    private boolean isRunning = false;

    public interface MusicSyncCallback {
        void onTrackChanged(MusicTrackInfo track);
        void onPlaybackStateChanged(boolean isPlaying);
    }

    public static class MusicTrackInfo {
        public String title;
        public String artist;
        public String album;
        public long position;
        public long duration;
        public boolean isPlaying;
        public int songIndex;

        @Override
        public boolean equals(Object obj) {
            if (!(obj instanceof MusicTrackInfo)) return false;
            MusicTrackInfo other = (MusicTrackInfo) obj;
            return equals(title, other.title) 
                && equals(artist, other.artist) 
                && equals(album, other.album);
        }

        private boolean equals(String a, String b) {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.equals(b);
        }
    }

    public MusicSyncMonitor(Activity activity, MusicSyncCallback callback) {
        this.activity = activity;
        this.callback = callback;
        this.handler = new Handler(Looper.getMainLooper());
        this.sessionManager = (MediaSessionManager) activity.getSystemService(Context.MEDIA_SESSION_SERVICE);
    }

    public void start() {
        if (isRunning) {
            Log.w(TAG, "Already running");
            return;
        }

        if (!hasNotificationListenerPermission()) {
            Log.w(TAG, "Notification listener permission not granted");
            requestNotificationListenerPermission();
            return;
        }

        isRunning = true;
        songIndex = 0;
        lastTrack = null;
        handler.post(pollRunnable);
        Log.i(TAG, "Started");
    }

    public void stop() {
        isRunning = false;
        handler.removeCallbacks(pollRunnable);
        if (currentController != null) {
            currentController.unregisterCallback(controllerCallback);
            currentController = null;
        }
        Log.i(TAG, "Stopped");
    }

    public MusicTrackInfo getCurrentTrack() {
        return lastTrack;
    }

    private boolean hasNotificationListenerPermission() {
        ComponentName cn = new ComponentName(activity, NotificationListener.class);
        String flat = android.provider.Settings.Secure.getString(
            activity.getContentResolver(),
            "enabled_notification_listeners"
        );
        return flat != null && flat.contains(cn.flattenToString());
    }

    private void requestNotificationListenerPermission() {
        try {
            android.content.Intent intent = new android.content.Intent(
                android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
            );
            activity.startActivity(intent);
            Log.i(TAG, "Requesting notification listener permission");
        } catch (Exception e) {
            Log.e(TAG, "Failed to request permission", e);
        }
    }

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (!isRunning) return;

            try {
                pollMediaSession();
            } catch (Exception e) {
                Log.e(TAG, "Poll error", e);
            }

            handler.postDelayed(this, POLL_INTERVAL_MS);
        }
    };

    private void pollMediaSession() {
        List<MediaController> controllers = sessionManager.getActiveSessions(
            new ComponentName(activity, NotificationListener.class)
        );

        if (controllers == null || controllers.isEmpty()) {
            if (currentController != null) {
                currentController.unregisterCallback(controllerCallback);
                currentController = null;
            }
            return;
        }

        MediaController controller = controllers.get(0);
        
        if (currentController != controller) {
            if (currentController != null) {
                currentController.unregisterCallback(controllerCallback);
            }
            currentController = controller;
            currentController.registerCallback(controllerCallback);
        }

        updateTrackInfo();
    }

    private void updateTrackInfo() {
        if (currentController == null) return;

        MediaMetadata metadata = currentController.getMetadata();
        PlaybackState playbackState = currentController.getPlaybackState();

        if (metadata == null) return;

        MusicTrackInfo track = new MusicTrackInfo();
        track.title = metadata.getString(MediaMetadata.METADATA_KEY_TITLE);
        track.artist = metadata.getString(MediaMetadata.METADATA_KEY_ARTIST);
        track.album = metadata.getString(MediaMetadata.METADATA_KEY_ALBUM);
        track.duration = metadata.getLong(MediaMetadata.METADATA_KEY_DURATION);
        track.position = playbackState != null ? playbackState.getPosition() : 0;
        track.isPlaying = playbackState != null 
            && playbackState.getState() == PlaybackState.STATE_PLAYING;

        // 检测歌曲切换
        if (lastTrack == null || !track.equals(lastTrack)) {
            songIndex++;
            track.songIndex = songIndex;
            lastTrack = track;
            
            Log.i(TAG, "Track changed: " + track.title + " - " + track.artist);
            if (callback != null) {
                callback.onTrackChanged(track);
            }
        } else if (lastTrack != null && track.isPlaying != lastTrack.isPlaying) {
            lastTrack.isPlaying = track.isPlaying;
            if (callback != null) {
                callback.onPlaybackStateChanged(track.isPlaying);
            }
        }
    }

    private final MediaController.Callback controllerCallback = new MediaController.Callback() {
        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            updateTrackInfo();
        }

        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            updateTrackInfo();
        }
    };
}
