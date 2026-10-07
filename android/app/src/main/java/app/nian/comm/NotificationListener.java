/**
 * NotificationListener - 用于获取通知栏访问权限
 * 音乐同步功能需要此服务来读取MediaSession
 */

package app.nian.comm;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public class NotificationListener extends NotificationListenerService {
    
    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        // 不需要实际处理通知，只是为了获取权限
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // 不需要实际处理通知
    }
}
