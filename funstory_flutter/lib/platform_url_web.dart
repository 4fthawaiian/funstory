import 'package:web/web.dart' as web;

void replaceBrowserPath(String path) {
  web.window.history.replaceState(null, '', path);
}
