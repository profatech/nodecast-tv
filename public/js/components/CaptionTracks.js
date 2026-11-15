/** Subtitle choices belong to the current source, not the browser's lifetime track list. */
class CaptionTracks {
    constructor(video, onChange = () => {}) {
        this.video = video;
        this.onChange = onChange;
        this.hls = null;
        this.probe = null;
        this.remoteTracks = [];
        this.external = null;
        this.externalTrack = null;
        this.timeOffset = 0;
        this.remoteCueTimes = new WeakMap();
        this.sessionCues = new WeakMap();
        this.session = null;
        this.hlsTracks = new Map();
        this.retired = new Set();
        this.generation = 0;
        this.selectionRevision = 0;
        this.video.textTracks?.addEventListener('change', onChange);
        this.video.textTracks?.addEventListener('addtrack', onChange);
        this.video.textTracks?.addEventListener('removetrack', onChange);
        this.video.addEventListener?.('loadedmetadata', onChange);
    }

    static isCaption(track) {
        return track.kind === 'subtitles' || track.kind === 'captions';
    }

    /** Canonical language subtag ("eng", "en-US" -> "en"); empty when unknown. */
    static languageKey(code) {
        const value = String(code || '').trim().toLowerCase().replace(/_/g, '-');
        if (!value || value === 'und' || value === 'off') return '';
        try { return new Intl.Locale(value).language; } catch (error) { return value; }
    }

    /** Readable English language name, or '' when the code is not a known language. */
    static languageName(code) {
        const key = CaptionTracks.languageKey(code);
        if (!key) return '';
        try {
            CaptionTracks.displayNames ||= new Intl.DisplayNames(['en'], { type: 'language' });
            const name = CaptionTracks.displayNames.of(key);
            return name && name.toLowerCase() !== key ? name : '';
        } catch (error) { return ''; }
    }

    /** Label for a probed stream: the language name, plus the title only when it says more. */
    static trackLabel({ language, title } = {}, fallback = '') {
        const code = CaptionTracks.languageKey(language) ? String(language).trim() : '', text = String(title || '').trim();
        const name = CaptionTracks.languageName(code);
        if (!name) return text || code || fallback;
        if (!text || text.toLowerCase() === code.toLowerCase() || name.toLowerCase().includes(text.toLowerCase())) return name;
        return text.toLowerCase().includes(name.toLowerCase()) ? text : `${name} - ${text}`;
    }

    /** Decode a subtitle file: UTF-8/UTF-16 when valid, otherwise a legacy Windows code page. */
    static decodeSubtitle(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const decode = (encoding, fatal = false) => new TextDecoder(encoding, { fatal }).decode(bytes);
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return decode('utf-16le');
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return decode('utf-16be');
        try { return decode('utf-8', true); } catch (error) { /* not UTF-8 */ }
        try { return decode(CaptionTracks.legacyEncoding(bytes)); } catch (error) { return decode('utf-8'); }
    }

    /** Guess the code page of non-UTF-8 text. Central European is the default. */
    static legacyEncoding(bytes) {
        const count = new Map();
        let letters = 0, high = 0;
        for (const byte of bytes) {
            if (byte >= 0x80) count.set(byte, (count.get(byte) || 0) + 1);
            if (byte >= 0xC0) high++;
            else if ((byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)) letters++;
        }
        const sum = values => values.reduce((total, byte) => total + (count.get(byte) || 0), 0);
        // Cyrillic text is almost entirely high bytes; Latin text only uses them for diacritics.
        if (high > letters) return 'windows-1251';
        // c-caron/c-acute/d-stroke (and their capitals) versus letters that only exist in Western text.
        // Plus letters only windows-1250 has (Polish, Hungarian, Romanian).
        const central = sum([0xE8, 0xE6, 0xF0, 0xC8, 0xC6, 0xD0, 0xB3, 0xB9, 0x9C, 0x9F, 0xBA, 0xFE, 0xF5, 0xFB]);
        const western = sum([0xE0, 0xE3, 0xE5, 0xEA, 0xF1]);
        return western > central ? 'windows-1252' : 'windows-1250';
    }

    /** Convert SubRip (or pass through WebVTT) text to WebVTT; '' when it holds no cues. */
    static toVtt(source) {
        const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        if (/^WEBVTT/.test(text)) return /-->/.test(text) ? text : '';
        const timing = /^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
        const stamp = (h, m, s, ms) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.padEnd(3, '0')}`;
        const cues = [];
        let cue = null;
        for (const line of text.split('\n')) {
            const match = timing.exec(line);
            if (match) {
                // The line before a timing is the SubRip counter, not text of the previous cue.
                if (cue?.lines.length && /^\s*\d+\s*$/.test(cue.lines[cue.lines.length - 1])) cue.lines.pop();
                cue = { time: `${stamp(...match.slice(1, 5))} --> ${stamp(...match.slice(5, 9))}`, lines: [] };
                cues.push(cue);
            } else if (cue) {
                // Drop ASS overrides and <font>, which WebVTT cannot express; "-->" would end the cue.
                cue.lines.push(line.replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, '').replace(/-->/g, '->'));
            }
        }
        const blocks = cues.map(({ time, lines }) => {
            const body = lines.map(line => line.trimEnd()).filter(line => line).join('\n');
            return body ? `${time}\n${body}` : '';
        }).filter(block => block);
        return blocks.length ? `WEBVTT\n\n${blocks.join('\n\n')}\n` : '';
    }

    disableNativeTracks() {
        for (const track of Array.from(this.video.textTracks || [])) {
            if (CaptionTracks.isCaption(track)) track.mode = 'disabled';
        }
    }

    removeRemoteTracks() {
        for (const element of this.remoteTracks) element.remove();
        this.remoteTracks = [];
    }

    retireNativeTracks() {
        for (const track of Array.from(this.video.textTracks || [])) {
            if (!CaptionTracks.isCaption(track)) continue;
            track.mode = 'hidden';
            for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
            track.mode = 'disabled';
        }
        this.removeRemoteTracks();
        this.externalTrack?.remove();
        this.externalTrack = null;
        for (const key of this.hlsTracks.keys()) this.removeHlsTrack(key);
        // addTextTrack tracks cannot be removed, and their addtrack event may arrive after reset.
        this.retired = new Set(Array.from(this.video.textTracks || []));
    }

    reset() {
        this.generation++;
        this.hls = null;
        this.probe = null;
        this.pendingRemoteSelection = null;
        this.timeOffset = 0;
        this.setSession(null);
        if (this.external) URL.revokeObjectURL(this.external.url);
        this.external = null;
        this.retireNativeTracks();
        this.onChange();
    }

    setProbe(info, url) {
        // Bitmap subtitles (text === false) cannot be converted to WebVTT.
        this.probe = { subtitles: (info?.subtitles || []).filter(subtitle => subtitle.text !== false), url };
    }

    /** Select the probed subtitle in this language once its track is added. */
    preferLanguage(language) {
        const key = CaptionTracks.languageKey(language);
        if (!key || !this.probe || this.remoteTracks.length || this.pendingRemoteSelection != null) return false;
        const index = this.probe.subtitles.findIndex(subtitle => CaptionTracks.languageKey(subtitle.language) === key);
        if (index < 0) return false;
        this.pendingRemoteSelection = index;
        return true;
    }

    /** Show a subtitle file the user picked. It is not uploaded and lasts until reset(). */
    loadExternal(name, text) {
        const vtt = CaptionTracks.toVtt(text);
        if (!vtt) return false;
        if (this.external) URL.revokeObjectURL(this.external.url);
        this.external = { label: String(name || '').replace(/\.[^.]+$/, '') || 'Subtitle file',
            url: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })) };
        this.pendingRemoteSelection = null;
        this.off();
        this.addExternalTrack(true);
        this.onChange();
        return true;
    }

    addExternalTrack(showing) {
        this.externalTrack?.remove();
        this.externalTrack = null;
        if (!this.external) return;
        const element = this.externalTrack = document.createElement('track');
        element.kind = 'subtitles';
        element.label = this.external.label;
        element.src = this.external.url;
        element.addEventListener('load', () => {
            if (this.externalTrack === element) this.alignRemoteCues(element);
        });
        this.video.appendChild(element);
        element.track.mode = showing ? 'showing' : 'disabled';
    }

    setTimeOffset(offset) {
        this.timeOffset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
        for (const element of this.remoteTracks) this.alignRemoteCues(element);
        if (this.externalTrack) this.alignRemoteCues(this.externalTrack);
    }

    alignRemoteCues(element) {
        const track = element.track, mode = track.mode;
        if (!track.cues?.length) return;
        track.mode = 'hidden';
        for (const cue of Array.from(track.cues || [])) {
            if (!this.remoteCueTimes.has(cue)) this.remoteCueTimes.set(cue, { start: cue.startTime, end: cue.endTime });
            const original = this.remoteCueTimes.get(cue);
            cue.startTime = Math.max(0, original.start - this.timeOffset);
            cue.endTime = Math.max(0, original.end - this.timeOffset);
        }
        track.mode = mode;
    }

    prepareMediaRecovery() {
        const tracks = Array.from(this.hlsTracks, ([key, entry]) => ({ key, entry,
            cues: Array.from(entry.element.track.cues || []), mode: entry.element.track.mode }));
        const hasRemoteTracks = this.remoteTracks.length > 0;
        const external = this.externalTrack, externalShowing = external?.track.mode === 'showing';
        if (!hasRemoteTracks && !tracks.length && !external) return;
        const selected = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
        const generation = this.generation, revision = this.selectionRevision;
        return () => {
            if (this.generation !== generation) return;
            // HLS detachment clears all native cues, including our owned caption tracks.
            for (const { key, entry, cues, mode } of tracks) {
                if (this.hlsTracks.get(key) !== entry) continue;
                this.appendHlsCues(entry, cues);
                if (this.selectionRevision === revision) entry.element.track.mode = mode;
            }
            if (hasRemoteTracks) {
                const remoteSelection = this.selectionRevision === revision ? selected :
                    this.remoteTracks.findIndex(element => element.track.mode === 'showing');
                this.removeRemoteTracks();
                this.addRemoteTracks();
                if (remoteSelection >= 0 && this.remoteTracks[remoteSelection]) this.remoteTracks[remoteSelection].track.mode = 'showing';
            }
            if (external && this.externalTrack === external) {
                this.addExternalTrack(this.selectionRevision === revision ? externalShowing : external.track.mode === 'showing');
            }
            this.onChange();
        };
    }

    useNative({ allowProbe = true } = {}) {
        this.generation++;
        this.hls = null;
        if (allowProbe) this.addRemoteTracks();
        this.onChange();
    }

    /** Probed subtitle streams a transcode session can write as WebVTT next to the video. */
    sessionStreams() {
        return (this.probe?.subtitles || []).filter(subtitle => CaptionTracks.SESSION_CODECS.includes(String(subtitle.codec || '').toLowerCase()))
            .map(subtitle => subtitle.index).filter(index => Number.isInteger(index) && index >= 0 && index <= 255).slice(0, 16);
    }

    /** The session that plays now writes these streams itself; read them from it instead of extracting again. */
    setSession(id, streams = []) {
        clearInterval(this.sessionTimer);
        this.sessionTimer = null;
        this.session = id ? { id, streams: new Set(streams) } : null;
        if (!this.session || !this.session.streams.size || typeof fetch !== 'function') return;
        this.sessionTimer = setInterval(() => this.pollSession(), 4000);
        this.pollSession();
    }

    /** Parse complete WebVTT cues; the file may still be growing, so an unfinished last block is ignored. */
    static parseVtt(source) {
        const text = String(source || '').replace(/\r\n?/g, '\n');
        const complete = text.slice(0, text.lastIndexOf('\n\n') + 1);
        const seconds = stamp => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
        const cues = [];
        for (const block of complete.split(/\n{2,}/)) {
            const lines = block.split('\n');
            const at = lines.findIndex(line => line.includes('-->'));
            if (at < 0) continue;
            const match = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}\.\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}\.\d{1,3})/.exec(lines[at]);
            const body = lines.slice(at + 1).join('\n').trim();
            if (!match || !body) continue;
            const start = seconds(match[1]), end = seconds(match[2]);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ start, end, text: body });
        }
        return cues;
    }

    /** Fetch what the session has written for the shown subtitle and add the new cues. */
    async pollSession() {
        const session = this.session;
        if (!session) return;
        for (const element of this.remoteTracks) {
            const state = this.sessionCues.get(element);
            if (!state || state.session !== session.id || state.loading || element.track.mode !== 'showing') continue;
            state.loading = true;
            try {
                const response = await fetch(`/api/transcode/${session.id}/subtitles/sub${state.index}.vtt`,
                    { credentials: 'same-origin', cache: 'no-store' });
                if (response.ok) state.cues = CaptionTracks.parseVtt(await response.text());
            } catch (error) { /* try again on the next poll */ }
            state.loading = false;
            if (this.session === session && this.remoteTracks.includes(element)) this.syncSessionCues(element);
        }
    }

    syncSessionCues(element) {
        const state = this.sessionCues.get(element), track = element.track;
        // Loading the element's (empty) file clears its cues, so wait for that before adding any.
        if (!state || element.readyState !== 2 || typeof VTTCue !== 'function') return;
        const mode = track.mode;
        track.mode = 'hidden';
        for (const { start, end, text } of state.cues) {
            const key = `${start}:${end}:${text}`;
            if (state.added.has(key)) continue;
            state.added.add(key);
            const cue = new VTTCue(Math.max(0, start - this.timeOffset), Math.max(0, end - this.timeOffset), text);
            this.remoteCueTimes.set(cue, { start, end });
            track.addCue(cue);
        }
        track.mode = mode;
    }

    addRemoteTracks() {
        if (this.remoteTracks.length || !this.probe) return;
        const session = this.session;
        for (const subtitle of this.probe.subtitles) {
            const element = document.createElement('track');
            element.kind = 'subtitles';
            element.label = CaptionTracks.trackLabel(subtitle, 'Subtitles');
            element.srclang = subtitle.language || '';
            if (session?.streams.has(subtitle.index)) {
                // Filled from the session's own subtitle file: no second connection to the provider.
                element.src = CaptionTracks.emptyTrackUrl ||= URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
                this.sessionCues.set(element, { session: session.id, index: subtitle.index, cues: [], added: new Set(), loading: false });
                element.addEventListener('load', () => {
                    if (!this.remoteTracks.includes(element)) return;
                    this.syncSessionCues(element);
                    this.pollSession();
                });
            } else {
                element.src = `/api/subtitle?url=${encodeURIComponent(this.probe.url)}&index=${subtitle.index}`;
                element.addEventListener('load', () => {
                    if (this.remoteTracks.includes(element)) this.alignRemoteCues(element);
                });
            }
            this.remoteTracks.push(element);
            this.video.appendChild(element);
        }
        const selected = this.remoteTracks[this.pendingRemoteSelection];
        this.pendingRemoteSelection = null;
        if (selected) selected.track.mode = 'showing';
        this.pollSession();
    }

    captureRemoteSelection() {
        // Without tracks there is nothing to capture; keep a selection that is still pending.
        if (!this.remoteTracks.length) return;
        this.pendingRemoteSelection = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
    }

    bindHls(hls, events) {
        const selected = this.remoteTracks.findIndex(element => element.track.mode === 'showing');
        if (selected >= 0) this.pendingRemoteSelection = selected;
        this.generation++;
        this.hls = hls;
        this.manifestReady = false;
        const externalShowing = this.externalTrack?.track.mode === 'showing';
        this.retireNativeTracks();
        // Retiring wipes every cue, so the user's file is loaded again for the new media.
        this.addExternalTrack(externalShowing);
        const refresh = () => { if (this.hls === hls) this.onChange(); };
        hls.on(events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            if (this.hls !== hls) return;
            // Own removable DOM tracks so HLS cannot route cues to an orphan with the same label.
            const keys = new Set();
            (data?.subtitleTracks || hls.subtitleTracks || []).forEach((track, index) => {
                const key = track.default ? 'default' : `subtitles${index}`;
                keys.add(key);
                const entry = this.hlsTracks.get(key);
                if (entry && entry.subtitle?.url !== track.url) {
                    this.removeHlsTrack(key);
                }
                this.addHlsTrack(key, track.name, track.lang, track);
                this.hlsTracks.get(key).subtitle = track;
            });
            for (const [key, entry] of this.hlsTracks) {
                if (entry.subtitle && !keys.has(key)) this.removeHlsTrack(key);
            }
            // Never extract a second copy of subtitles already supplied by the manifest.
            if (hls.subtitleTracks?.length) this.removeRemoteTracks();
            this.syncHlsModes();
            refresh();
        });
        hls.on(events.SUBTITLE_TRACK_SWITCH, () => {
            if (this.hls !== hls) return;
            this.syncHlsModes();
            refresh();
        });
        hls.on(events.NON_NATIVE_TEXT_TRACKS_FOUND, (event, data) => {
            if (this.hls !== hls) return;
            for (const track of data.tracks) {
                if (track._id) this.addHlsTrack(track._id, track.label, track.closedCaptions?.lang);
            }
            refresh();
        });
        hls.on(events.CUES_PARSED, (event, data) => {
            if (this.hls !== hls) return;
            const entry = this.hlsTracks.get(data.track);
            if (!entry) return;
            // Loading an HTML track clears pre-existing cues. Buffer early CEA cues until load.
            if (entry.element.readyState !== 2) entry.pending.push(...data.cues);
            else this.appendHlsCues(entry, data.cues);
        });
        hls.on(events.MANIFEST_PARSED, (event, data) => {
            if (this.hls !== hls) return;
            this.manifestReady = true;
            // The active group getter may still be empty during MANIFEST_PARSED.
            // Use the manifest data to avoid briefly adding an extracted duplicate.
            if (!data?.subtitleTracks?.length && !hls.subtitleTracks?.length) this.addRemoteTracks();
            refresh();
        });
        refresh();
    }

    addHlsTrack(key, label, language, subtitle = null) {
        if (this.hlsTracks.has(key)) return;
        const element = document.createElement('track');
        element.kind = subtitle ? 'subtitles' : 'captions';
        element.label = label || 'Captions';
        element.srclang = language || '';
        element.src = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
        const entry = { element, subtitle, pending: [] };
        this.hlsTracks.set(key, entry);
        element.addEventListener('load', () => {
            if (this.hlsTracks.get(key) !== entry) return;
            this.appendHlsCues(entry, entry.pending);
            entry.pending = [];
            if (element.track.mode === 'hidden') element.track.mode = 'disabled';
        });
        this.video.appendChild(element);
        element.track.mode = 'hidden';
    }

    removeHlsTrack(key) {
        const entry = this.hlsTracks.get(key);
        if (!entry) return;
        this.hlsTracks.delete(key);
        entry.element.remove();
        URL.revokeObjectURL(entry.element.src);
    }

    appendHlsCues(entry, cues) {
        const track = entry.element.track;
        const mode = track.mode;
        track.mode = 'hidden';
        const keys = new Set();
        const key = cue => `${cue.startTime}:${cue.endTime}:${cue.text}:${cue.line}:${cue.position}:${cue.align}:${cue.size}:${cue.id}`;
        const live = entry.subtitle?.details?.live || this.hls?.levels?.[this.hls.currentLevel]?.details?.live;
        for (const cue of Array.from(track.cues || [])) {
            if (live && cue.endTime < this.video.currentTime - 60) track.removeCue(cue);
            else keys.add(key(cue));
        }
        for (const cue of cues) {
            if (!keys.has(key(cue))) { track.addCue(cue); keys.add(key(cue)); }
        }
        track.mode = mode;
    }

    syncHlsModes() {
        const externalShowing = this.externalTrack?.track.mode === 'showing';
        this.disableNativeTracks();
        const subtitle = this.hls?.subtitleTracks?.[this.hls.subtitleTrack];
        if (!subtitle || this.hls.subtitleDisplay === false) {
            // The user's file is not an HLS track; keep it on while HLS shows nothing.
            if (externalShowing) this.externalTrack.track.mode = 'showing';
            return;
        }
        for (const entry of this.hlsTracks.values()) {
            if (entry.subtitle === subtitle) entry.element.track.mode = 'showing';
        }
    }

    choices() {
        const hls = this.hls;
        const generation = this.generation;
        const choices = [];
        if (hls && !this.manifestReady) return choices;
        if (hls?.subtitleTracks?.length) {
            hls.subtitleTracks.forEach((track, index) => {
                const suffix = [];
                if (track.forced) suffix.push('Forced');
                const characteristics = track.attrs?.CHARACTERISTICS || '';
                if (characteristics.includes('public.accessibility.describes-music-and-sound')) suffix.push('SDH');
                const name = track.name || track.lang || `Track ${index + 1}`;
                choices.push({ label: suffix.length ? `${name} (${suffix.join(', ')})` : name, language: track.lang || '',
                    active: hls.subtitleDisplay !== false && hls.subtitleTrack === index,
                    select: () => {
                        if (this.hls !== hls || hls.subtitleTracks[index] !== track) return;
                        this.selectionRevision++;
                        this.disableNativeTracks();
                        hls.subtitleDisplay = true;
                        hls.subtitleTrack = index;
                        this.syncHlsModes();
                    } });
            });
        }

        const elements = new Set(Array.from(this.video.querySelectorAll?.('track') || [], element => element.track));
        const hlsSubtitles = new Set(Array.from(this.hlsTracks.values()).filter(entry => entry.subtitle).map(entry => entry.element.track));
        for (const track of Array.from(this.video.textTracks || [])) {
            if (!CaptionTracks.isCaption(track)) continue;
            if (hlsSubtitles.has(track)) continue;
            // Ignore tracks left over from earlier sources; retain current DOM/native tracks.
            if (this.retired.has(track) && !track.cues?.length && !elements.has(track)) continue;
            choices.push({ label: track.label || track.language || `Track ${choices.length + 1}`,
                language: track.language || '', external: this.externalTrack?.track === track,
                active: track.mode === 'showing', select: () => {
                    if (this.generation !== generation) return;
                    this.off();
                    track.mode = 'showing';
                    const remote = [...this.remoteTracks, this.externalTrack].find(element => element?.track === track);
                    if (remote) this.alignRemoteCues(remote);
                    this.pollSession();
                } });
        }
        const counts = new Map();
        for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) || 0) + 1);
        const positions = new Map();
        for (const choice of choices) {
            if (counts.get(choice.label) <= 1) continue;
            const position = (positions.get(choice.label) || 0) + 1;
            positions.set(choice.label, position);
            choice.label += ` (Track ${position})`;
        }
        return choices;
    }

    off() {
        this.selectionRevision++;
        if (this.hls) {
            this.hls.subtitleTrack = -1;
            this.hls.subtitleDisplay = false;
        }
        this.disableNativeTracks();
    }

    /** onSelect receives the chosen choice, or null for Off. */
    render(list, onSelect) {
        const choices = this.choices();
        list.replaceChildren();
        const append = (label, active, select, choice = null) => {
            const button = document.createElement('button');
            button.className = 'captions-option';
            button.textContent = label;
            if (active) button.classList.add('active');
            button.onclick = event => {
                event.stopPropagation();
                select();
                this.onChange();
                onSelect(choice);
            };
            list.appendChild(button);
        };
        append('Off', !choices.some(choice => choice.active), () => this.off());
        for (const choice of choices) append(choice.label, choice.active, choice.select, choice);
    }
}

// Text subtitle codecs FFmpeg converts to WebVTT.
CaptionTracks.SESSION_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];

if (typeof window !== 'undefined') window.CaptionTracks = CaptionTracks;
if (typeof module !== 'undefined') module.exports = CaptionTracks;
