package app.nian.comm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class NianAlarmReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (context == null) return;
    int id = intent != null ? intent.getIntExtra(NianAlarms.EXTRA_ID, 0) : 0;
    if (id <= 0) return;
    NianAlarmService.start(context, id);
    NianAlarmActivity.show(context, id);
  }
}
