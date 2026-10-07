package app.nian.comm;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 锁屏来电：微信式全屏，接听打开念并接通，拒绝只挂断。 */
public class IncomingCallActivity extends Activity {
  public static void show(Context ctx, int characterId, String name, String content, int logId) {
    Intent i = new Intent(ctx, IncomingCallActivity.class);
    i.putExtra(IncomingCallService.EXTRA_CHAR_ID, characterId);
    i.putExtra(IncomingCallService.EXTRA_NAME, name);
    i.putExtra(IncomingCallService.EXTRA_CONTENT, content);
    i.putExtra(IncomingCallService.EXTRA_LOG_ID, logId);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
    ctx.startActivity(i);
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    showOnLockscreen();
    int charId = getIntent() != null ? getIntent().getIntExtra(IncomingCallService.EXTRA_CHAR_ID, 0) : 0;
    String name = getIntent() != null ? getIntent().getStringExtra(IncomingCallService.EXTRA_NAME) : "TA";
    if (name == null || name.trim().isEmpty()) name = "TA";

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER_HORIZONTAL);
    root.setBackgroundColor(Color.parseColor("#111214"));
    root.setPadding(dp(28), dp(96), dp(28), dp(56));

    LinearLayout hero = new LinearLayout(this);
    hero.setOrientation(LinearLayout.VERTICAL);
    hero.setGravity(Gravity.CENTER_HORIZONTAL);
    LinearLayout.LayoutParams heroLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
    root.addView(hero, heroLp);

    TextView avatar = new TextView(this);
    String initial = name.trim().substring(0, 1);
    avatar.setText(initial);
    avatar.setTextColor(Color.WHITE);
    avatar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32);
    avatar.setTypeface(Typeface.DEFAULT_BOLD);
    avatar.setGravity(Gravity.CENTER);
    avatar.setBackground(circle(Color.parseColor("#4C4F57")));
    LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(dp(86), dp(86));
    avLp.topMargin = dp(24);
    avLp.bottomMargin = dp(18);
    hero.addView(avatar, avLp);

    TextView who = new TextView(this);
    who.setText(name);
    who.setTextColor(Color.WHITE);
    who.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
    who.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.NORMAL));
    who.setGravity(Gravity.CENTER);
    who.setMaxLines(1);
    hero.addView(who);

    TextView kind = new TextView(this);
    kind.setText("邀请你语音通话");
    kind.setTextColor(Color.parseColor("#94FFFFFF"));
    kind.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
    kind.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams kindLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    kindLp.topMargin = dp(10);
    hero.addView(kind, kindLp);

    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    row.addView(actionBtn("拒绝", Color.parseColor("#FA5151"), v -> {
      IncomingCallService.reportOutcome(this, "declined");
      IncomingCallService.dismiss(this);
      finish();
    }), actionSlot());
    final int answerId = charId;
    row.addView(actionBtn("接听", Color.parseColor("#07C160"), v -> {
      IncomingCallService.dismiss(this);
      MainActivity.openAnswerIncoming(this, answerId);
      finish();
    }), actionSlot());
    root.addView(row, rowLp);
    setContentView(root);
  }

  private LinearLayout.LayoutParams actionSlot() {
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    return lp;
  }

  private View actionBtn(String label, int color, View.OnClickListener tap) {
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setGravity(Gravity.CENTER_HORIZONTAL);

    // 微信式：白色矢量图标（ic_call.xml）放在按钮背景上；拒绝按钮沿用 135° 旋转实现挂断方向
    ImageView btn = new ImageView(this);
    btn.setImageResource(R.drawable.ic_call);
    btn.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    btn.setBackground(circle(color));
    if ("拒绝".equals(label)) btn.setRotation(135f);
    btn.setOnClickListener(tap);
    col.addView(btn, new LinearLayout.LayoutParams(dp(64), dp(64)));

    TextView caption = new TextView(this);
    caption.setText(label);
    caption.setTextColor(Color.parseColor("#C7FFFFFF"));
    caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    caption.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams capLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    capLp.topMargin = dp(10);
    col.addView(caption, capLp);
    return col;
  }

  private static GradientDrawable circle(int color) {
    GradientDrawable d = new GradientDrawable();
    d.setShape(GradientDrawable.OVAL);
    d.setColor(color);
    return d;
  }

  private void showOnLockscreen() {
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    } else {
      getWindow().addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
          | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      );
    }
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  private int dp(int v) {
    return Math.round(v * getResources().getDisplayMetrics().density);
  }
}
