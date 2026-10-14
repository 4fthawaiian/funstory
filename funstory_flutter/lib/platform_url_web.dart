import 'dart:js_interop';

import 'package:web/web.dart' as web;

void replaceBrowserPath(String path) {
  web.window.history.replaceState(null, '', path);
}

void speakText(String text, void Function() onEnd) {
  final utterance = web.SpeechSynthesisUtterance(text);
  final done = ((web.Event _) => onEnd()).toJS;
  utterance.addEventListener('end', done);
  utterance.addEventListener('error', done);
  web.window.speechSynthesis.speak(utterance);
}

void stopSpeech() {
  web.window.speechSynthesis.cancel();
}
