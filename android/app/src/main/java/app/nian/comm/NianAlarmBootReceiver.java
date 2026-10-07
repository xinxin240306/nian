package app.nian.comm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class NianAlarmBootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (context == null) return;
    NianAlarms.rescheduleAll(context);
  }
}
