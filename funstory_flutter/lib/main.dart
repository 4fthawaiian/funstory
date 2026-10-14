import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;

import 'platform_url.dart';

const String defaultBackendUrl = 'https://funstory.4ft.me';

/// Origin to build share URLs from — the web app's own origin when running
/// in a browser, otherwise the configured backend.
String shareOrigin(String backendUrl) {
  final base = Uri.base;
  return base.hasAuthority ? base.origin : backendUrl;
}

void main() {
  runApp(const FunStoryApp());
}

class FunStoryApp extends StatelessWidget {
  const FunStoryApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FunStory',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF38BDF8),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF0F172A),
      ),
      home: const NarratePage(),
    );
  }
}

class NarratePage extends StatefulWidget {
  const NarratePage({super.key});

  @override
  State<NarratePage> createState() => _NarratePageState();
}

class _NarratePageState extends State<NarratePage> {
  final TextEditingController _queryController = TextEditingController();
  final TextEditingController _backendController =
      TextEditingController(text: defaultBackendUrl);
  final ScrollController _scrollController = ScrollController();

  bool _loading = false;
  bool _readerMode = false;
  String _narrative = '';
  String? _error;

  String? _storyTitle;
  String _shareUrl = '';
  bool _cached = false;
  List<dynamic> _related = [];
  bool _relatedLoading = false;

  @override
  void initState() {
    super.initState();
    final backend = Uri.base.queryParameters['backend'];
    if (backend != null && backend.isNotEmpty) {
      _backendController.text = backend;
    }
    final segs = Uri.base.pathSegments;
    if (segs.length >= 2 && segs[0] == 's' && segs[1].isNotEmpty) {
      _loadSharedStory(segs[1]);
    }
  }

  @override
  void dispose() {
    _queryController.dispose();
    _backendController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _goHome() {
    setState(() {
      _readerMode = false;
      _loading = false;
      _narrative = '';
      _error = null;
      _storyTitle = null;
      _shareUrl = '';
      _cached = false;
      _related = [];
      _relatedLoading = false;
    });
    replaceBrowserPath('/');
  }

  Future<void> _loadSharedStory(String slug) async {
    final baseUrl = _backendController.text.trim();
    setState(() {
      _readerMode = true;
      _loading = true;
      _error = null;
    });
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/story/$slug'));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        setState(() {
          _narrative = (data['text'] as String?) ?? '';
          _storyTitle = (data['title'] as String?) ?? slug;
          _queryController.text = _storyTitle!;
          _shareUrl = '${shareOrigin(baseUrl)}/s/$slug';
          _related = (data['related'] as List?) ?? [];
        });
        if (_related.isEmpty) {
          _fetchRelated(slug);
        }
      } else {
        setState(() => _error = 'Story "$slug" not found.');
      }
    } catch (e) {
      setState(() => _error = 'Cannot reach backend at $baseUrl.\n($e)');
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _generate({bool regen = false}) async {
    final query = _queryController.text.trim();
    if (query.isEmpty) return;

    setState(() {
      _readerMode = true;
      _loading = true;
      _narrative = '';
      _error = null;
      _storyTitle = null;
      _shareUrl = '';
      _cached = false;
      _related = [];
      _relatedLoading = false;
    });

    final baseUrl = _backendController.text.trim();
    final uri = Uri.parse('$baseUrl/api/narrate');

    try {
      final request = http.Request('POST', uri)
        ..headers['Content-Type'] = 'application/json'
        ..body = jsonEncode({'query': query, 'regen': regen});

      final response = await http.Client().send(request);

      if (response.statusCode != 200) {
        final body = await response.stream.bytesToString();
        final detail = _parseError(body) ?? 'HTTP ${response.statusCode}';
        setState(() {
          _error = detail;
          _loading = false;
        });
        return;
      }

      final storySlug = response.headers['x-story-id'];
      final storyCached = response.headers['x-story-cached'] == '1';

      await for (final chunk in response.stream.transform(utf8.decoder)) {
        setState(() {
          _narrative += chunk;
          _loading = false;
        });
        _scrollToBottom();
      }

      setState(() {
        _storyTitle = query;
        _cached = storyCached;
        _shareUrl = storySlug == null
            ? ''
            : '${shareOrigin(baseUrl)}/s/$storySlug';
      });
      if (storySlug != null) {
        replaceBrowserPath('/s/$storySlug');
        _fetchRelated(storySlug);
      }
    } on http.ClientException catch (e) {
      setState(() {
        _error = 'Cannot reach backend at $baseUrl. Is the server running?\n($e)';
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _fetchRelated(String slug) async {
    final baseUrl = _backendController.text.trim();
    setState(() => _relatedLoading = true);
    try {
      final res = await http
          .get(Uri.parse('$baseUrl/api/story/$slug/related'))
          .timeout(const Duration(seconds: 90));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        setState(() => _related = (data['related'] as List?) ?? []);
      }
    } catch (_) {
      // Related suggestions are a nice-to-have; fail quietly
    } finally {
      if (mounted) setState(() => _relatedLoading = false);
    }
  }

  String? _parseError(String body) {
    try {
      final json = jsonDecode(body) as Map<String, dynamic>;
      return json['detail'] as String?;
    } catch (_) {
      return body.isNotEmpty ? body : null;
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _copyShareLink() async {
    await Clipboard.setData(ClipboardData(text: _shareUrl));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Share link copied'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  void _setExample(String q) {
    _queryController.text = q;
  }

  void _openSettings() {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Backend'),
        content: TextField(
          controller: _backendController,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Backend URL',
            hintText: 'http://localhost:8765',
          ),
          style: const TextStyle(fontSize: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final reading = _readerMode || _narrative.isNotEmpty;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _buildTopBar(colorScheme),
            if (_error != null) _buildErrorBanner(),
            Expanded(
              child: reading
                  ? _buildReader(colorScheme)
                  : _buildLanding(colorScheme),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTopBar(ColorScheme colorScheme) {
    final reading = _readerMode || _narrative.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      child: Row(
        children: [
          InkWell(
            onTap: _goHome,
            borderRadius: BorderRadius.circular(6),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
              child: Text(
                'FunStory',
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      color: colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
              ),
            ),
          ),
          const Spacer(),
          if (_shareUrl.isNotEmpty) ...[
            IconButton(
              icon: const Icon(Icons.copy, size: 20),
              tooltip: 'Copy share link',
              onPressed: _copyShareLink,
              color: Colors.white70,
            ),
            IconButton(
              icon: const Icon(Icons.refresh, size: 20),
              tooltip: 'Regenerate',
              onPressed: _loading ? null : () => _generate(regen: true),
              color: Colors.white70,
            ),
          ],
          if (reading)
            TextButton.icon(
              onPressed: _goHome,
              icon: const Icon(Icons.add, size: 18),
              label: const Text('New story'),
            )
          else
            IconButton(
              icon: const Icon(Icons.settings_outlined, size: 18),
              tooltip: 'Backend settings',
              onPressed: _openSettings,
              color: Colors.white24,
            ),
        ],
      ),
    );
  }

  Widget _buildErrorBanner() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.red.shade900.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Colors.redAccent, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Text(_error!, style: const TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }

  Widget _buildLanding(ColorScheme colorScheme) {
    return Center(
      child: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Turn any Wikipedia page into a compelling narrative.',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: Colors.white70,
                      ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _queryController,
                        decoration: InputDecoration(
                          hintText: 'URL or title, e.g. Ada Lovelace',
                          filled: true,
                          fillColor: const Color(0xFF1E293B),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: BorderSide.none,
                          ),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 16,
                          ),
                        ),
                        style: const TextStyle(color: Colors.white),
                        textInputAction: TextInputAction.go,
                        onSubmitted: (_) => _generate(),
                      ),
                    ),
                    const SizedBox(width: 12),
                    FilledButton(
                      onPressed: _loading ? null : _generate,
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 24,
                          vertical: 16,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: _loading
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text('Tell me a story'),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _buildExamples(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildExamples() {
    final examples = ['Ada Lovelace', 'Golden Gate Bridge', 'Chernobyl disaster'];
    return Wrap(
      spacing: 8,
      alignment: WrapAlignment.center,
      children: examples
          .map(
            (q) => ActionChip(
              label: Text(q),
              onPressed: () => _setExample(q),
              backgroundColor: const Color(0xFF1E293B),
              side: BorderSide.none,
            ),
          )
          .toList(),
    );
  }

  Widget _buildReader(ColorScheme colorScheme) {
    if (_loading && _narrative.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    return SingleChildScrollView(
      controller: _scrollController,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 700),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 64),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _storyTitle ?? _queryController.text,
                  style: GoogleFonts.merriweather(
                    fontSize: 30,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                    height: 1.25,
                  ),
                ),
                if (_shareUrl.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Icon(Icons.link, size: 14, color: Colors.white38),
                      const SizedBox(width: 6),
                      Expanded(
                        child: SelectableText(
                          _shareUrl,
                          style: const TextStyle(
                            color: Colors.white38,
                            fontSize: 12,
                          ),
                        ),
                      ),
                      if (_cached)
                        const Text(
                          'cached',
                          style: TextStyle(
                            color: Colors.white24,
                            fontSize: 12,
                          ),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 28),
                _buildStoryBody(colorScheme),
                _buildRelated(colorScheme),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildStoryBody(ColorScheme colorScheme) {
    final bodyStyle = GoogleFonts.merriweather(
      fontSize: 18,
      height: 1.75,
      color: Colors.white.withValues(alpha: 0.87),
    );
    final headStyle = GoogleFonts.merriweather(
      fontSize: 22,
      fontWeight: FontWeight.bold,
      height: 1.4,
      color: Colors.white,
    );

    final text = _loading ? '$_narrative▍' : _narrative;
    final paragraphs = text
        .split(RegExp(r'\n{2,}'))
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final p in paragraphs)
          Padding(
            padding: const EdgeInsets.only(bottom: 22),
            child: _buildParagraph(p, bodyStyle, headStyle),
          ),
      ],
    );
  }

  Widget _buildRelated(ColorScheme colorScheme) {
    if (_related.isEmpty && !_relatedLoading) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 8),
        const Divider(color: Colors.white12),
        const SizedBox(height: 16),
        Text(
          'FURTHER READING',
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.5),
            fontSize: 12,
            letterSpacing: 1.6,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        if (_relatedLoading && _related.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text(
              'Finding related topics…',
              style: TextStyle(color: Colors.white38, fontSize: 13),
            ),
          )
        else
          for (final r in _related) _relatedTile(r, colorScheme),
      ],
    );
  }

  Widget _relatedTile(Map<String, dynamic> r, ColorScheme colorScheme) {
    return InkWell(
      onTap: () {
        _queryController.text = (r['title'] as String?) ?? '';
        _generate();
      },
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    (r['title'] as String?) ?? '',
                    style: TextStyle(
                      color: colorScheme.primary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (((r['description'] as String?) ?? '').isNotEmpty)
                    Text(
                      r['description'] as String,
                      style: const TextStyle(
                        color: Colors.white38,
                        fontSize: 13,
                      ),
                    ),
                ],
              ),
            ),
            const Icon(
              Icons.arrow_forward_ios,
              size: 12,
              color: Colors.white24,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildParagraph(String p, TextStyle bodyStyle, TextStyle headStyle) {
    if (p.startsWith('**') &&
        p.endsWith('**') &&
        p.length > 4 &&
        !p.substring(2, p.length - 2).contains('**')) {
      return SelectableText(p.substring(2, p.length - 2), style: headStyle);
    }
    return SelectableText.rich(
      TextSpan(children: _inlineSpans(p, bodyStyle)),
      style: bodyStyle,
    );
  }

  List<TextSpan> _inlineSpans(String text, TextStyle base) {
    final bold = base.copyWith(fontWeight: FontWeight.bold, color: Colors.white);
    final spans = <TextSpan>[];
    var i = 0;
    for (final m in RegExp(r'\*\*(.+?)\*\*').allMatches(text)) {
      if (m.start > i) {
        spans.add(TextSpan(text: text.substring(i, m.start), style: base));
      }
      spans.add(TextSpan(text: m.group(1), style: bold));
      i = m.end;
    }
    if (i < text.length) {
      spans.add(TextSpan(text: text.substring(i), style: base));
    }
    return spans;
  }
}
