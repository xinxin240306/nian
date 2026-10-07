package app.nian.comm;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 系统弹出健康权限前会打开这一页，说明念为什么要读。 */
public class HealthPermissionRationaleActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    int pad = Math.round(22 * getResources().getDisplayMetrics().density);
    root.setPadding(pad, pad, pad, pad);
    root.setBackgroundColor(Color.parseColor("#1A1224"));

    TextView title = new TextView(this);
    title.setText("念要读哪些健康数据");
    title.setTextColor(Color.parseColor("#F3E8FF"));
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
    title.setPadding(0, 0, 0, pad / 2);

    TextView body = new TextView(this);
    body.setText("角色只会读你授权过的项目：今天的步数、最近睡眠、心率、血氧、运动、步行距离和热量。\n\n"
      + "手表/手环的数据要先写进系统的「健康数据共享」。三星健康：设置里打开与健康数据共享的同步，勾选心率、睡眠、血氧。授权页请一并勾选「后台读取」。\n\n"
      + "不会用来打广告，也不会写回你的健康记录。随时可在系统健康权限里关掉。");
    body.setTextColor(Color.parseColor("#DDE8D5F5"));
    body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
    body.setLineSpacing(0, 1.25f);

    TextView ok = new TextView(this);
    ok.setText("知道了");
    ok.setTextColor(Color.parseColor("#E8D5F5"));
    ok.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    ok.setGravity(Gravity.END);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = pad;
    ok.setLayoutParams(lp);
    ok.setOnClickListener(v -> finish());

    root.addView(title);
    root.addView(body);
    root.addView(ok);
    setContentView(root);
  }
}
