package app.nian.comm;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.Locale;

/** 锁屏全屏闹钟：关掉 / 再睡 5 分钟。 */
public class NianAlarmActivity extends Activity {
  public static void show(Context ctx, int id) {
    Intent i = new Intent(ctx, NianAlarmActivity.class);
    i.putExtra(NianAlarms.EXTRA_ID, id);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
    ctx.startActivity(i);
  }

  private int alarmId;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    alarmId = getIntent() != null ? getIntent().getIntExtra(NianAlarms.EXTRA_ID, 0) : 0;
    showOnLockscreen();
    JSONObject item = NianAlarms.get(this, alarmId);
    String name = item != null ? item.optString("name", "念") : "念";
    String speech = item != null ? item.optString("speech", "") : "";
    int hour = item != null ? item.optInt("hour") : 0;
    int minute = item != null ? item.optInt("minute") : 0;
    String time = String.format(Locale.CHINA, "%02d:%02d", hour, minute);
    if (speech.isEmpty()) speech = "该起床了。";

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    root.setBackgroundColor(Color.parseColor("#12081A"));
    int pad = dp(28);
    root.setPadding(pad, pad, pad, pad);

    TextView who = new TextView(this);
    who.setText(name.isEmpty() ? "闹钟" : name);
    who.setTextColor(Color.parseColor("#E8D5F5"));
    who.setTextSize(18);
    who.setGravity(Gravity.CENTER);
    root.addView(who);

    TextView clock = new TextView(this);
    clock.setText(time);
    clock.setTextColor(Color.WHITE);
    clock.setTextSize(64);
    clock.setTypeface(Typeface.DEFAULT_BOLD);
    clock.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams clockLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    clockLp.topMargin = dp(12);
    clockLp.bottomMargin = dp(20);
    root.addView(clock, clockLp);

    TextView line = new TextView(this);
    line.setText(speech);
    line.setTextColor(Color.parseColor("#DCC6EC"));
    line.setTextSize(18);
    line.setGravity(Gravity.CENTER);
    line.setLineSpacing(0, 1.25f);
    LinearLayout.LayoutParams lineLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lineLp.bottomMargin = dp(36);
    root.addView(line, lineLp);

    Button dismiss = pill(this, "关掉", Color.parseColor("#E8D5F5"), Color.parseColor("#1A0E24"));
    dismiss.setOnClickListener(v -> {
      NianAlarms.dismiss(this, alarmId);
      finish();
    });
    root.addView(dismiss, btnLp(this, 0));

    Button snooze = pill(this, "再睡 5 分钟", Color.parseColor("#2A1838"), Color.parseColor("#E8D5F5"));
    snooze.setOnClickListener(v -> {
      NianAlarms.snooze(this, alarmId);
      finish();
    });
    root.addView(snooze, btnLp(this, dp(12)));

    setContentView(root);
    if (!NianAlarmService.isRunning()) NianAlarmService.start(this, alarmId);
  }

  @Override
  public void onBackPressed() {
    // 必须点关掉或贪睡，避免误触返回把闹钟闷掉
  }

  private void showOnLockscreen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    }
    getWindow().addFlags(
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
        | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
    );
  }

  private static Button pill(Context ctx, String text, int bg, int fg) {
    Button b = new Button(ctx);
    b.setText(text);
    b.setAllCaps(false);
    b.setTextSize(16);
    b.setTextColor(fg);
    b.setBackgroundColor(bg);
    b.setPadding(dp(ctx, 16), dp(ctx, 14), dp(ctx, 16), dp(ctx, 14));
    return b;
  }

  private static LinearLayout.LayoutParams btnLp(Context ctx, int top) {
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = top;
    return lp;
  }

  private int dp(int v) {
    return dp(this, v);
  }

  private static int dp(Context ctx, int v) {
    return Math.round(v * ctx.getResources().getDisplayMetrics().density);
  }
}
