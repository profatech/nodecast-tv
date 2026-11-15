const test = require('node:test');
const assert = require('node:assert/strict');
const AudioTracks = require('../public/js/components/AudioTracks.js');
const CaptionTracks = require('../public/js/components/CaptionTracks.js');

// Frontend unit tests with a hand-rolled DOM: no browser or installed dependencies needed.
function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}

function fakeDom(t) {
    const created = [];
    class Element {
        constructor(tag) {
            this.tag = tag; this.children = []; this.listeners = {}; this.className = '';
            this.classList = { add: name => { this.className += ' ' + name; } };
            if (tag === 'track') {
                const element = this, cues = [];
                this.track = { mode: 'disabled', cues, get kind() { return element.kind; }, get label() { return element.label; },
                    get language() { return element.srclang || ''; }, addCue: cue => cues.push(cue),
                    removeCue: cue => cues.splice(cues.indexOf(cue), 1) };
            }
            created.push(this);
        }
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
        dispatch(type) { for (const listener of this.listeners[type] || []) listener(); }
        appendChild(child) { child.parent = this; this.children.push(child); }
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
        replaceChildren() { this.children = []; }
        querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); }
        get textTracks() {
            return Object.assign(this.children.filter(child => child.tag === 'track').map(child => child.track), { addEventListener() {} });
        }
    }
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { globalThis.document = previous; });
    return { video: new Element('video'), list: new Element('div'), created };
}

function fakeHls() {
    const handlers = {};
    return { subtitleTracks: [], on: (event, handler) => { handlers[event] = handler; }, emit: (event, data) => handlers[event]?.(event, data) };
}
const events = { SUBTITLE_TRACKS_UPDATED: 'tracks', SUBTITLE_TRACK_SWITCH: 'switch', NON_NATIVE_TEXT_TRACKS_FOUND: 'found',
    CUES_PARSED: 'cues', MANIFEST_PARSED: 'manifest' };

const tracks = () => [
    { index: 1, track: 0, language: 'eng', title: '', codec: 'ac3', channels: 6, default: true },
    { index: 2, track: 1, language: 'srp', title: 'Sinhronizacija', codec: 'aac', channels: 2, default: false },
    { index: 3, track: 2, language: 'eng', title: 'Commentary', codec: 'aac', channels: 2, default: false }
];

test('audio labels use language names, informative titles and a codec/channel hint', () => {
    assert.equal(AudioTracks.label({ language: 'eng', codec: 'ac3', channels: 6 }), 'English \u00B7 AC3 5.1');
    assert.equal(AudioTracks.label({ language: 'srp', title: 'Sinhronizacija', codec: 'aac', channels: 2 }), 'Serbian - Sinhronizacija \u00B7 AAC Stereo');
    assert.equal(AudioTracks.label({ language: 'hrv', title: 'Croatian', codec: 'eac3', channels: 8 }), 'Croatian \u00B7 E-AC3 7.1');
    assert.equal(AudioTracks.label({ language: 'ger', title: 'German (Director)', codec: 'dts', channels: 1 }), 'German (Director) \u00B7 DTS Mono');
    assert.equal(AudioTracks.label({ language: 'und', title: '', codec: 'unknown', channels: 0 }, 3), 'Track 3');
    assert.equal(AudioTracks.label({ language: 'qaa', title: 'Original', codec: 'mp3', channels: 3 }), 'Original \u00B7 MP3 3ch');

    const audio = new AudioTracks(storage());
    audio.setTracks([{ track: 0, language: 'eng', codec: 'aac', channels: 2 }, { track: 1, language: 'en', codec: 'aac', channels: 2 },
        { track: 2, language: 'fre', codec: 'aac', channels: 2 }]);
    assert.deepEqual(audio.choices().map(choice => choice.label),
        ['English \u00B7 AAC Stereo (Track 1)', 'English \u00B7 AAC Stereo (Track 2)', 'French \u00B7 AAC Stereo']);
    assert.deepEqual(audio.choices().map(choice => choice.active), [true, false, false]);
});

test('audio menu is unavailable below two tracks and tolerates a probe without audioTracks', () => {
    const audio = new AudioTracks(storage({ 'nodecast-audio-lang': 'sr' }));
    for (const list of [undefined, null, [], tracks().slice(0, 1), [{ language: 'eng' }, { track: -1 }]]) {
        audio.setTracks(list);
        assert.equal(audio.available, false);
        assert.equal(audio.preferred(), null);
        assert.deepEqual(audio.sessionOptions(), {});
    }
    audio.setTracks(tracks());
    assert.equal(audio.available, true);
});

test('selecting an audio track yields the session payload and remembers its language', () => {
    const store = storage(), audio = new AudioTracks(store), list = tracks();
    audio.setTracks(list);
    assert.deepEqual(audio.sessionOptions(), {}, 'untouched playback must not send audioTrack');
    assert.deepEqual(audio.select(list[1]), { audioTrack: 1, audioCodec: 'aac', audioChannels: 2 });
    assert.equal(store.getItem('nodecast-audio-lang'), 'sr');
    assert.deepEqual(audio.choices().map(choice => choice.active), [false, true, false]);
    // Options of an earlier session (default track's codec) are overridden by the selected track's.
    assert.deepEqual({ videoMode: 'copy', audioCodec: 'ac3', audioChannels: 6, ...audio.sessionOptions(), seekOffset: 42 },
        { videoMode: 'copy', audioCodec: 'aac', audioChannels: 2, audioTrack: 1, seekOffset: 42 });
    // Going back to the first track stays explicit so the restarted session gets its codec again.
    assert.deepEqual(audio.select(list[0]), { audioTrack: 0, audioCodec: 'ac3', audioChannels: 6 });
    assert.deepEqual(audio.select({ track: 9 }), { audioTrack: 0, audioCodec: 'ac3', audioChannels: 6 }, 'foreign tracks are ignored');
    audio.reset();
    assert.deepEqual([audio.available, audio.explicit, audio.sessionOptions()], [false, false, {}]);
});

test('remembered audio language picks a non-default track only', () => {
    const list = tracks();
    const preferred = value => { const audio = new AudioTracks(storage(value == null ? {} : { 'nodecast-audio-lang': value })); audio.setTracks(list); return audio.preferred(); };
    assert.equal(preferred('sr'), list[1]);
    assert.equal(preferred('srp'), list[1], 'three-letter codes match too');
    assert.equal(preferred('en'), null, 'first match is track 0: play as usual');
    assert.equal(preferred('de'), null);
    assert.equal(preferred(null), null);
    const audio = new AudioTracks(storage({ 'nodecast-audio-lang': 'sr' }));
    audio.setTracks(list);
    audio.select(audio.preferred(), { remember: false });
    assert.deepEqual(audio.sessionOptions(), { audioTrack: 1, audioCodec: 'aac', audioChannels: 2 });
});

test('audio menu renders one option per track and reports the clicked one', t => {
    const { list } = fakeDom(t), audio = new AudioTracks(storage()), clicks = [];
    audio.setTracks(tracks());
    audio.render(list, (track, active) => clicks.push([track.track, active]));
    assert.deepEqual(list.children.map(button => button.textContent),
        ['English \u00B7 AC3 5.1', 'Serbian - Sinhronizacija \u00B7 AAC Stereo', 'English - Commentary \u00B7 AAC Stereo']);
    assert.match(list.children[0].className, /captions-option active/);
    for (const button of list.children) button.onclick({ stopPropagation() {} });
    assert.deepEqual(clicks, [[0, true], [1, false], [2, false]]);
});

test('SRT is converted to WebVTT and WebVTT passes through', () => {
    const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:04,000\r\n{\\an8}<font color="#fff">Prva</font> linija\r\ndruga <i>linija</i>\r\n\r\n' +
        '2\r\n0:00:08,5 --> 0:00:11,250 X1:10 Y1:20\r\n42\r\n\r\n3\r\n00:00:12,000 --> 00:00:13,000\r\n\r\n4\n01:02:03.004 --> 01:02:05.000\nkraj --> ovdje\n';
    assert.equal(CaptionTracks.toVtt(srt), 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nPrva linija\ndruga <i>linija</i>\n\n' +
        '00:00:08.500 --> 00:00:11.250\n42\n\n01:02:03.004 --> 01:02:05.000\nkraj -> ovdje\n');
    const vtt = 'WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n';
    assert.equal(CaptionTracks.toVtt(vtt), 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
    assert.equal(CaptionTracks.toVtt('not a subtitle'), '');
    assert.equal(CaptionTracks.toVtt('WEBVTT\n\n'), '');
});

test('subtitle files decode as UTF-8 with or without BOM, else as a Windows code page', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\nŠta će čovjek, đavo ne spava. Žao mi je.\n';
    const utf8 = new TextEncoder().encode(text);
    assert.equal(CaptionTracks.decodeSubtitle(utf8), text);
    assert.equal(CaptionTracks.decodeSubtitle(new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8]).buffer), text);
    const cp1250 = { 'Š': 0x8A, 'š': 0x9A, 'Ž': 0x8E, 'ž': 0x9E, 'č': 0xE8, 'ć': 0xE6, 'đ': 0xF0 };
    assert.equal(CaptionTracks.decodeSubtitle(Uint8Array.from(text, char => cp1250[char] ?? char.charCodeAt(0))), text);
    const french = 'Voil\u00E0 un caf\u00E9, se\u00F1or. \u00C7a va tr\u00E8s bien.';
    assert.equal(CaptionTracks.decodeSubtitle(Uint8Array.from(french, char => char.charCodeAt(0))), french);
    // "Живели" in windows-1251: Cyrillic text consists almost only of high bytes.
    assert.equal(CaptionTracks.decodeSubtitle(new Uint8Array([0xC6, 0xE8, 0xE2, 0xE5, 0xEB, 0xE8])), '\u0416\u0438\u0432\u0435\u043B\u0438');
    const utf16 = new Uint8Array([0xFF, 0xFE, ...Array.from('\u010Dao', char => [char.charCodeAt(0) & 0xFF, char.charCodeAt(0) >> 8]).flat()]);
    assert.equal(CaptionTracks.decodeSubtitle(utf16), '\u010Dao');
});

test('probed subtitles hide bitmap tracks, get readable labels and honour a remembered language', t => {
    const { video } = fakeDom(t), captions = new CaptionTracks(video);
    captions.setProbe({ subtitles: [
        { index: 2, language: 'eng', title: 'English', codec: 'subrip', text: true },
        { index: 3, language: 'eng', title: 'PGS', codec: 'hdmv_pgs_subtitle', text: false },
        { index: 4, language: 'hrv', title: '', codec: 'ass' },
        { index: 5, language: 'srp', title: 'Forced', codec: 'subrip', text: true },
        { index: 6, language: 'und', title: '', codec: 'subrip', text: true }
    ] }, 'http://provider.test/movie.mkv');
    assert.equal(captions.preferLanguage('off'), false);
    assert.equal(captions.preferLanguage('de'), false);
    assert.equal(captions.preferLanguage('hr'), true);
    captions.useNative();
    const elements = video.querySelectorAll('track');
    assert.deepEqual(elements.map(element => element.label), ['English', 'Croatian', 'Serbian - Forced', 'Subtitles']);
    assert.deepEqual(elements.map(element => new URL(element.src, 'http://x').searchParams.get('index')), ['2', '4', '5', '6']);
    assert.deepEqual(elements.map(element => element.track.mode), ['disabled', 'showing', 'disabled', 'disabled']);
    const choices = captions.choices();
    assert.deepEqual(choices.map(choice => [choice.label, choice.language, choice.active, choice.external]),
        [['English', 'eng', false, false], ['Croatian', 'hrv', true, false], ['Serbian - Forced', 'srp', false, false], ['Subtitles', 'und', false, false]]);
    // A restart before the tracks exist must not forget the pending choice.
    captions.reset();
    captions.setProbe({ subtitles: [{ index: 2, language: 'hrv' }] }, 'http://provider.test/movie.mkv');
    captions.preferLanguage('hr');
    captions.captureRemoteSelection();
    assert.equal(captions.pendingRemoteSelection, 0);
});

test('a loaded subtitle file works without a probe, survives rebinds with aligned cues and is cleared on reset', t => {
    const { video, list } = fakeDom(t);
    let changes = 0;
    const captions = new CaptionTracks(video, () => { changes++; });
    const external = () => video.querySelectorAll('track').filter(element => element.label.startsWith('Film'));
    const load = element => {
        // Stand in for the browser parsing the blob, then firing the track's load event.
        for (const [startTime, endTime] of [[1, 4], [100, 104]]) element.track.addCue({ startTime, endTime, text: 'cue' });
        element.dispatch('load');
    };
    assert.equal(captions.loadExternal('empty.srt', 'no cues here'), false);
    assert.equal(external().length, 0);
    assert.equal(captions.loadExternal('Film.sr.srt', '1\n00:00:01,000 --> 00:00:04,000\nZdravo\n\n2\n00:01:40,000 --> 00:01:44,000\nKraj\n'), true);
    assert.ok(changes > 0);
    let [element] = external();
    assert.deepEqual([element.kind, element.label, element.track.mode], ['subtitles', 'Film.sr', 'showing']);
    load(element);
    assert.deepEqual(captions.choices().map(choice => [choice.label, choice.active, choice.external]), [['Film.sr', true, true]]);

    // Seek / audio switch: the page sets the new session offset, then binds a new HLS instance.
    for (const offset of [90, 30]) {
        const hls = fakeHls();
        captions.setTimeOffset(offset);
        captions.bindHls(hls, events);
        const [rebound] = external();
        assert.notEqual(rebound, element, 'retired cues require a fresh track element');
        assert.equal(external().length, 1);
        assert.equal(rebound.track.mode, 'showing');
        load(rebound);
        assert.deepEqual(rebound.track.cues.map(cue => [cue.startTime, cue.endTime]), [[0, 0], [100 - offset, 104 - offset]]);
        hls.emit(events.MANIFEST_PARSED, { subtitleTracks: [] });
        assert.deepEqual(captions.choices().map(choice => [choice.label, choice.active]), [['Film.sr', true]]);
        // Manifest subtitles replace probed tracks but never the user's file.
        hls.subtitleTracks = [{ name: 'English', lang: 'en', url: '/sub.m3u8' }];
        hls.subtitleTrack = -1;
        hls.emit(events.SUBTITLE_TRACKS_UPDATED, { subtitleTracks: hls.subtitleTracks });
        assert.equal(external().includes(rebound), true);
        assert.deepEqual(captions.choices().map(choice => [choice.label, choice.active]), [['English', false], ['Film.sr', true]]);
        element = rebound;
    }
    captions.setTimeOffset(0);
    assert.deepEqual(element.track.cues.map(cue => [cue.startTime, cue.endTime]), [[1, 4], [100, 104]]);

    // Media recovery wipes cues; the restore callback loads the file again and keeps it selected.
    const restore = captions.prepareMediaRecovery();
    assert.equal(typeof restore, 'function');
    restore();
    assert.notEqual(external()[0], element);
    assert.equal(external()[0].track.mode, 'showing');

    // Turning subtitles off survives a rebind as well.
    captions.off();
    captions.bindHls(fakeHls(), events);
    assert.equal(external()[0].track.mode, 'disabled');

    // The menu reports what was chosen so the page can tell a file from a language.
    captions.useNative();
    const selected = [];
    captions.render(list, choice => selected.push(choice));
    assert.deepEqual(list.children.map(button => button.textContent), ['Off', 'Film.sr']);
    for (const button of list.children) button.onclick({ stopPropagation() {} });
    assert.deepEqual(selected.map(choice => choice && choice.external), [null, true]);
    assert.equal(external()[0].track.mode, 'showing');

    captions.reset();
    assert.equal(external().length, 0);
    assert.equal(captions.external, null);
    captions.bindHls(fakeHls(), events);
    assert.equal(external().length, 0, 'a new video starts without the previous file');
});

// WatchPage wiring, with the session layer and player replaced by recorders.
function watchFixture(t, { settings = { autoTranscode: true }, probe, stored = {} } = {}) {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { list } = fakeDom(t), window = {}, store = storage(stored);
    const context = { window, console: { log() {}, warn() {}, error() {} }, document: globalThis.document, localStorage: store,
        CaptionTracks, AudioTracks, VodDuration: require('../public/js/components/VodDuration'),
        PlaybackProbe: require('../public/js/components/PlaybackProbe'), Hls: { isSupported: () => false },
        API: { settings: { get: async () => settings } }, fetch: async () => ({ json: async () => probe }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8'), context);
    const watch = Object.create(window.WatchPage.prototype), hidden = new Set(['hidden']);
    const video = globalThis.document.createElement('video');
    Object.assign(video, { src: '', currentTime: 0, paused: false, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load() {} });
    Object.assign(watch, { video, sessions: [], played: [], status: [], audioList: list, audioTracks: new AudioTracks(store),
        audioWrapper: { classList: { toggle: (name, on) => on ? hidden.add(name) : hidden.delete(name) } }, content: { type: 'movie' }, resumeTime: 0,
        stopHistoryTracking() {}, saveProgress() {}, hideNowPlaying() {}, showLoading() {}, hideLoading() {}, updateQualityBadge() {}, setVolumeFromStorage() {},
        updateTranscodeStatus(mode, text) { this.status.push(text || mode); },
        stopTranscodeSession() { this.currentSessionId = null; this.playbackTimeOffset = 0; },
        async startTranscodeSession(url, options) {
            this.sessions.push(JSON.parse(JSON.stringify(options))); // plain copy: the page runs in another realm
            if (this.failSessions) { this.stopTranscodeSession(); return null; }
            await this.sessionGate;
            this.currentSessionId = 'session' + this.sessions.length; this.currentTranscodeOptions = options;
            this.playbackTimeOffset = Number(options.seekOffset) || 0;
            return `/session${this.sessions.length}.m3u8`;
        },
        playHls(url) { this.hls = { destroy() {} }; this.played.push(url); this.video.currentTime = 0; } });
    return { watch, store, audioHidden: () => hidden.has('hidden'), labels: () => list.children.map(button => button.textContent), list };
}
const probeResult = extra => ({ video: 'h264', audio: 'ac3', audioChannels: 6, height: 1080, duration: 600, compatible: true,
    audioTracks: tracks(), subtitles: [], ...extra });

test('Watch page shows the audio menu only for several tracks and plays untouched files as before', async t => {
    const single = watchFixture(t, { probe: probeResult({ audioTracks: tracks().slice(0, 1) }) });
    await single.watch.loadVideo('http://provider.test/movie.mp4');
    assert.equal(single.audioHidden(), true);
    assert.deepEqual([single.watch.sessions.length, single.watch.video.src], [0, 'http://provider.test/movie.mp4']);

    const legacy = watchFixture(t, { probe: probeResult({ audioTracks: undefined, needsRemux: true }) });
    await legacy.watch.loadVideo('http://provider.test/movie.mkv');
    assert.equal(legacy.audioHidden(), true);
    assert.equal('audioTrack' in legacy.watch.sessions[0], false);

    const several = watchFixture(t, { probe: probeResult({ needsTranscode: true }), stored: { 'nodecast-audio-lang': 'en' } });
    await several.watch.loadVideo('http://provider.test/movie.mkv');
    assert.equal(several.audioHidden(), false);
    assert.equal(several.labels().length, 3);
    assert.deepEqual(several.watch.sessions, [{ program: null, videoMode: 'copy', seekOffset: 0, videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6, videoHeight: 1080 }]);
    several.watch.stop();
    assert.equal(several.audioHidden(), true);
    assert.deepEqual(several.labels(), []);
});

test('Watch page starts with the remembered audio language even when the file could play directly', async t => {
    const { watch } = watchFixture(t, { probe: probeResult(), stored: { 'nodecast-audio-lang': 'sr' } });
    watch.resumeTime = 75;
    await watch.loadVideo('http://provider.test/movie.mp4');
    assert.deepEqual(watch.sessions, [{ program: null, videoMode: 'copy', seekOffset: 75, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2,
        videoHeight: 1080, audioTrack: 1 }]);
    assert.deepEqual([watch.played, watch.video.src, watch.status.at(-1)], [['/session1.m3u8'], '', 'Remux (Audio)']);
    assert.deepEqual(watch.getAudioTracks().choices().map(choice => choice.active), [false, true, false]);
});

test('Watch page switches audio at the current position, from a session and from direct play', async t => {
    const { watch, store, list } = watchFixture(t, { probe: probeResult({ needsRemux: true }) });
    await watch.loadVideo('http://provider.test/movie.mkv');
    watch.video.currentTime = 42;
    list.children[2].onclick({ stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(watch.sessions[1], { program: null, videoMode: 'copy', seekOffset: 42, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2,
        videoHeight: 1080, audioTrack: 2 });
    assert.deepEqual(watch.played, ['/session1.m3u8', '/session2.m3u8']);
    assert.equal(store.getItem('nodecast-audio-lang'), 'en');
    // Later seeks reuse the session options, so the chosen track sticks.
    watch.sourceDuration = 600;
    watch.video.currentTime = 8;
    await watch.seekToContentTime(300);
    assert.deepEqual([watch.sessions[2].audioTrack, watch.sessions[2].audioCodec, watch.sessions[2].seekOffset], [2, 'aac', 300]);
    // Clicking the active track does nothing.
    list.children[2].onclick({ stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(watch.sessions.length, 3);

    const direct = watchFixture(t, { probe: probeResult() });
    await direct.watch.loadVideo('http://provider.test/movie.mp4');
    assert.equal(direct.watch.sessions.length, 0);
    direct.watch.video.currentTime = 30;
    await direct.watch.switchAudioTrack(direct.watch.getAudioTracks().tracks[1]);
    assert.deepEqual(direct.watch.sessions, [{ program: null, videoMode: 'copy', videoCodec: 'h264', videoHeight: 1080, audioTrack: 1, audioCodec: 'aac',
        audioChannels: 2, seekOffset: 30 }]);
    assert.deepEqual([direct.watch.played, direct.watch.status.at(-1)], [['/session1.m3u8'], 'Remux (Audio)']);
    assert.equal(direct.watch.getCurrentPlaybackTime(), 30);
});

test('Watch page drops an audio switch that finishes after playback changed and restores a failed one', async t => {
    const { watch } = watchFixture(t, { probe: probeResult() });
    await watch.loadVideo('http://provider.test/movie.mp4');
    let release;
    watch.sessionGate = new Promise(resolve => { release = resolve; });
    const switching = watch.switchAudioTrack(watch.getAudioTracks().tracks[1]);
    watch.stop();
    release();
    await switching;
    assert.deepEqual(watch.played, []);

    const failing = watchFixture(t, { probe: probeResult() });
    await failing.watch.loadVideo('http://provider.test/movie.mp4');
    failing.watch.failSessions = true;
    await failing.watch.switchAudioTrack(failing.watch.getAudioTracks().tracks[1]);
    assert.deepEqual(failing.watch.getAudioTracks().choices().map(choice => choice.active), [true, false, false]);
    assert.deepEqual([failing.watch.video.paused, failing.watch.getAudioTracks().sessionOptions()], [false, {}]);
});

test('Watch page remembers the subtitle language, not a loaded file, and shows a picked file', async t => {
    const { watch, store } = watchFixture(t, { probe: probeResult({ subtitles: [{ index: 3, language: 'eng', text: true }, { index: 4, language: 'hrv', text: true }] }),
        stored: { 'nodecast-subtitle-lang': 'hr' } });
    await watch.loadVideo('http://provider.test/movie.mp4');
    const showing = () => watch.video.querySelectorAll('track').filter(element => element.track.mode === 'showing').map(element => element.label);
    assert.deepEqual(showing(), ['Croatian'], 'remembered language is selected for a new video');
    watch.rememberSubtitleLanguage({ language: 'eng' });
    assert.equal(store.getItem('nodecast-subtitle-lang'), 'en');
    watch.rememberSubtitleLanguage({ language: '', external: true });
    assert.equal(store.getItem('nodecast-subtitle-lang'), 'en');
    watch.rememberSubtitleLanguage(null);
    assert.equal(store.getItem('nodecast-subtitle-lang'), 'off');

    // windows-1250 bytes: the file is decoded and shown without any request.
    const bytes = Uint8Array.from('1\n00:00:01,000 --> 00:00:02,000\n\u0160to\n', char => char === '\u0160' ? 0x8A : char.charCodeAt(0));
    await watch.loadSubtitleFile({ name: 'Film.srt', arrayBuffer: async () => bytes.buffer });
    assert.deepEqual(showing(), ['Film']);
    // A file that finishes loading after the video changed is dropped.
    const stale = watch.loadSubtitleFile({ name: 'Old.srt', arrayBuffer: async () => bytes.buffer });
    watch.stop();
    await stale;
    assert.equal(watch.video.querySelectorAll('track').length, 0);
});
