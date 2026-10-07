package app.nian.comm;

interface INianShizukuService {
  void destroy() = 16777114;
  void exit() = 1;
  String applyHelpers(String pkg, String listenerComponent) = 2;
  byte[] captureScreen() = 3;
  String getCurrentMediaSession() = 4;
  boolean sendMediaControl(String action) = 5;
}
