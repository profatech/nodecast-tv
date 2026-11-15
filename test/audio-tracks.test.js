const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Minimal express stand-in so these tests run without installed dependencies.
function fakeExpress() {
    const routes = {};
    const add = method => (route, ...handlers) => { routes[`${method} ${route}`] = handlers; };
    return { Router: () => ({ routes, get: add('GET'), post: add('POST'), delete: add('DELETE') }) };
}
const plain = value => JSON.parse(JSON.stringify(value));

function analyze(probeResult, url = 'http://provider.test/movie.mkv', program = null) {
    const filename = path.join(__dirname, '../server/routes/probe.js'), realRequire = createRequire(filename);
    const context = vm.createContext({ module: { exports: {} }, console,
        require: id => id === 'express' ? fakeExpress() : realRequire(id) });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return plain(context.analyzeProbeResult(probeResult, url, program));
}

test('probe lists every audio track with its ordinal, language, codec, channels and default flag', () => {
    const info = analyze({ streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'AC3', channels: 6, disposition: { default: 1 }, tags: { language: 'eng', title: 'Surround' } },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
        { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, disposition: { default: 0 }, tags: { language: 'ara' } },
        { index: 4, codec_type: 'audio' }
    ], format: { format_name: 'matroska,webm' } });
    assert.deepEqual(info.audioTracks, [
        { index: 1, track: 0, language: 'eng', title: 'Surround', codec: 'ac3', channels: 6, default: true },
        { index: 3, track: 1, language: 'ara', title: '', codec: 'aac', channels: 2, default: false },
        { index: 4, track: 2, language: 'und', title: '', codec: 'unknown', channels: 0, default: false }
    ]);
    // Existing first-track fields are unchanged.
    assert.equal(info.audio, 'ac3');
    assert.equal(info.audioChannels, 6);
    assert.deepEqual(info.audioCodecs, ['ac3', 'aac', 'unknown']);
    assert.deepEqual(analyze({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }], format: {} }).audioTracks, []);
});

test('probe audio track ordinals are relative to the selected program', () => {
    const streams = [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'mp2', channels: 2, tags: { language: 'deu' } },
        { index: 2, codec_type: 'video', codec_name: 'h264' },
        { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'fra' } },
        { index: 4, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } }
    ];
    const info = analyze({ streams, programs: [{ program_id: 1, streams: streams.slice(0, 2) }, { program_id: 2, streams: streams.slice(2) }],
        format: { format_name: 'mpegts' } }, 'http://provider.test/mux.ts', '2');
    assert.deepEqual(info.audioTracks.map(({ index, track, language }) => ({ index, track, language })),
        [{ index: 3, track: 0, language: 'fra' }, { index: 4, track: 1, language: 'eng' }]);
});

test('probe flags bitmap subtitles as non-text without removing them', () => {
    const codecs = ['subrip', 'ass', 'mov_text', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext'];
    const info = analyze({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' },
        ...codecs.map((codec_name, i) => ({ index: i + 1, codec_type: 'subtitle', codec_name, tags: { language: 'eng' } })),
        { index: 20, codec_type: 'subtitle' }], format: { format_name: 'matroska,webm' } });
    assert.deepEqual(info.subtitles.map(s => [s.index, s.codec, s.text]), [
        [1, 'subrip', true], [2, 'ass', true], [3, 'mov_text', true], [4, 'webvtt', true],
        [5, 'hdmv_pgs_subtitle', false], [6, 'dvd_subtitle', false], [7, 'dvb_subtitle', false], [8, 'xsub', false], [9, 'dvb_teletext', false],
        [20, undefined, true]
    ]);
    assert.deepEqual(info.subtitles[0], { index: 1, language: 'eng', title: 'eng', codec: 'subrip', text: true });
});

function loadService() {
    const filename = path.join(__dirname, '../server/services/transcodeSession.js'), realRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
        require: id => id === './hwDetect' ? { getCapabilities: () => null } : realRequire(id) }, { filename });
    return module.exports;
}
const maps = args => Array.from(args).flatMap((arg, i) => arg === '-map' ? [args[i + 1]] : []);

test('transcode sessions map the requested audio track with and without a program', () => {
    const { TranscodeSession } = loadService(), url = 'http://provider.test/movie.mkv';
    const build = options => maps(new TranscodeSession(url, { videoMode: 'copy', videoCodec: 'h264', ...options }).buildFFmpegArgs());
    assert.deepEqual(build({}), ['0:v:0', '0:a:0?']);
    assert.deepEqual(build({ audioTrack: null }), ['0:v:0', '0:a:0?']);
    assert.deepEqual(build({ audioTrack: 2 }), ['0:v:0', '0:a:2?']);
    assert.deepEqual(build({ audioTrack: 63, videoMode: 'encode' }), ['0:v:0', '0:a:63?']);
    assert.deepEqual(build({ program: 7 }), ['0:p:7:v:0', '0:p:7:a:0?']);
    assert.deepEqual(build({ program: '7', audioTrack: 1 }), ['0:p:7:v:0', '0:p:7:a:1?']);
    for (const audioTrack of [-1, 64, 1.5, '1', '0:s:0', NaN, true, [1], {}]) {
        assert.throws(() => new TranscodeSession(url, { audioTrack }), /Invalid audio track/);
    }
});

test('the selected track codec still drives the audio copy-versus-transcode decision', () => {
    const { TranscodeSession } = loadService(), url = 'http://provider.test/movie.mkv';
    const codec = options => { const args = new TranscodeSession(url, { videoMode: 'copy', audioTrack: 1, ...options }).buildFFmpegArgs(); return args[args.indexOf('-c:a') + 1]; };
    assert.equal(codec({ audioCodec: 'aac', audioChannels: 2 }), 'copy');
    assert.equal(codec({ audioCodec: 'ac3', audioChannels: 6 }), 'aac');
    assert.equal(codec({ audioCodec: 'aac', audioChannels: 6 }), 'aac');
});

test('every session request creates its own session, so audio tracks never share one', async t => {
    const service = loadService(), url = 'http://provider.test/movie.mkv';
    const sessions = [await service.createSession(url, { ownerId: 1, audioTrack: 0 }), await service.createSession(url, { ownerId: 1, audioTrack: 1 }),
        await service.getOrCreateSession(url, { ownerId: 1, audioTrack: 0 })];
    t.after(() => { for (const session of sessions) service.removeSession(session.id); });
    assert.equal(new Set(sessions.map(session => session.id)).size, 3);
    assert.deepEqual(sessions.map(session => session.options.audioTrack), [0, 1, 0]);
});

function sessionRoute(created) {
    const filename = path.join(__dirname, '../server/routes/transcode.js'), realRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console: { log() {}, error() {} }, require(id) {
        if (id === 'express') return fakeExpress();
        if (id === '../db') return { settings: { get: async () => ({}) }, getUserAgent: () => 'test' };
        if (id === '../auth') return { requireAdmin: (req, res, next) => next() };
        if (id === '../services/requestLimits') return { requestLimit: () => (req, res, next) => next() };
        if (id === '../services/transcodeSession') return { startCleanupInterval() {}, async removeSession() {},
            async createSession(url, options) { created.push(options); return { id: 'session', status: 'running', start: async () => {}, waitForPlaylist: async () => true, resolveStartTime: async () => options.seekOffset }; } };
        return realRequire(id);
    } }, { filename });
    const handler = module.exports.routes['POST /session'].at(-1);
    return async body => {
        const res = { statusCode: 200, writableEnded: false, once() {}, status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; this.writableEnded = true; return this; } };
        await handler({ body, user: { id: 1 }, app: { locals: {} } }, res);
        return res;
    };
}

test('session endpoint defaults, forwards and validates audioTrack', async () => {
    const created = [], post = sessionRoute(created), url = 'http://provider.test/movie.mkv';
    for (const [body, expected] of [[{ url }, 0], [{ url, audioTrack: null }, 0], [{ url, audioTrack: 0 }, 0], [{ url, audioTrack: 3 }, 3], [{ url, audioTrack: 63 }, 63]]) {
        const res = await post(body);
        assert.equal(res.statusCode, 200);
        assert.equal(created.at(-1).audioTrack, expected);
    }
    const accepted = created.length;
    for (const audioTrack of [-1, 64, 1.5, '1', '', 'eng', true, false, [1], {}]) {
        const res = await post({ url, audioTrack });
        assert.equal(res.statusCode, 400, `audioTrack ${JSON.stringify(audioTrack)}`);
        assert.deepEqual(plain(res.body), { error: 'Invalid audio track' });
    }
    assert.equal(created.length, accepted);
});

test('VOD seeks use a fast input seek with source timestamps; live and fallback sessions do not', () => {
    const { TranscodeSession } = loadService();
    const build = options => new TranscodeSession('http://provider.test/movie.mkv', { videoMode: 'copy', videoCodec: 'h264', ...options }).buildFFmpegArgs();
    const fast = build({ seekOffset: 1500 });
    assert.ok(fast.indexOf('-ss') < fast.indexOf('-i') && fast[fast.indexOf('-ss') + 1] === '1500');
    assert.ok(fast.includes('-noaccurate_seek') && fast.includes('-copyts') && fast.includes('-muxdelay'));
    const start = build({});
    assert.ok(!start.includes('-ss') && !start.includes('-copyts'));
    const session = new TranscodeSession('http://provider.test/movie.mkv', { videoMode: 'copy', seekOffset: 1500 });
    session.legacySeek = true;
    const slow = session.buildFFmpegArgs();
    assert.ok(slow.indexOf('-ss') > slow.indexOf('-i') && !slow.includes('-copyts'));
});
