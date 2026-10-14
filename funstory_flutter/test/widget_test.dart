import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:funstory/main.dart';

void main() {
  testWidgets('FunStory renders input and button', (WidgetTester tester) async {
    await tester.pumpWidget(const FunStoryApp());

    expect(find.text('FunStory'), findsOneWidget);
    expect(find.text('Tell me a story'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });
}
