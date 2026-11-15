/** Audio choices of the current VOD source, as reported by the probe. Switching is done by the page. */
class AudioTracks {
    constructor(storage = null) {
        this.storage = storage;
        this.reset();
    }

    static get labels() {
        return typeof CaptionTracks !== 'undefined' ? CaptionTracks : require('./CaptionTracks');
    }

    static codecLabel(codec) {
        const value = String(codec || '').toLowerCase();
        const names = { eac3: 'E-AC3', truehd: 'TrueHD', opus: 'Opus', vorbis: 'Vorbis' };
        if (!value || value === 'unknown') return '';
        if (value.startsWith('pcm')) return 'PCM';
        return names[value] || value.toUpperCase();
    }

    static channelLabel(channels) {
        const count = Number(channels);
        if (!Number.isFinite(count) || count <= 0) return '';
        return { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[count] || `${count}ch`;
    }

    /** "English - Commentary - AC3 5.1": language, informative title, then a format hint. */
    static label(track, position = 1) {
        const name = AudioTracks.labels.trackLabel(track, `Track ${position}`);
        const format = [AudioTracks.codecLabel(track.codec), AudioTracks.channelLabel(track.channels)].filter(Boolean).join(' ');
        return format ? `${name} · ${format}` : name;
    }

    reset() {
        this.tracks = [];
        this.selected = 0;
        // Until a track is chosen the server plays its own default and gets no audioTrack.
        this.explicit = false;
    }

    setTracks(tracks) {
        this.reset();
        this.tracks = (Array.isArray(tracks) ? tracks : []).filter(track => Number.isInteger(track?.track) && track.track >= 0);
        this.selected = this.tracks[0]?.track ?? 0;
    }

    /** The menu is pointless with a single track. */
    get available() {
        return this.tracks.length >= 2;
    }

    current() {
        return this.tracks.find(track => track.track === this.selected) || null;
    }

    getStorage() {
        try { return this.storage || globalThis.localStorage || null; } catch (error) { return null; }
    }

    /** Track in the remembered language, unless that is already the one played by default. */
    preferred() {
        let stored = '';
        try { stored = this.getStorage()?.getItem(AudioTracks.STORAGE_KEY) || ''; } catch (error) { /* storage blocked */ }
        const key = AudioTracks.labels.languageKey(stored);
        if (!key || !this.available) return null;
        const match = this.tracks.find(track => AudioTracks.labels.languageKey(track.language) === key);
        return match && match !== this.tracks[0] ? match : null;
    }

    /** Choose a track and return the options a transcode session needs to play it. */
    select(track, { remember = true } = {}) {
        if (!this.tracks.includes(track)) return this.sessionOptions();
        this.selected = track.track;
        this.explicit = true;
        const key = AudioTracks.labels.languageKey(track.language);
        if (remember && key) {
            try { this.getStorage()?.setItem(AudioTracks.STORAGE_KEY, key); } catch (error) { /* storage blocked */ }
        }
        return this.sessionOptions();
    }

    /** Empty until a track was chosen, so untouched playback requests stay as they were. */
    sessionOptions() {
        const track = this.explicit ? this.current() : null;
        // Codec and channels describe the selected stream; the server uses them to copy or transcode.
        return track ? { audioTrack: track.track, audioCodec: track.codec, audioChannels: track.channels } : {};
    }

    choices() {
        const choices = this.tracks.map((track, index) => ({ track, label: AudioTracks.label(track, index + 1),
            active: track.track === this.selected }));
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

    render(list, onSelect) {
        list.replaceChildren();
        for (const choice of this.choices()) {
            const button = document.createElement('button');
            button.className = 'captions-option';
            button.textContent = choice.label;
            if (choice.active) button.classList.add('active');
            button.onclick = event => {
                event.stopPropagation();
                onSelect(choice.track, choice.active);
            };
            list.appendChild(button);
        }
    }
}

AudioTracks.STORAGE_KEY = 'nodecast-audio-lang';

if (typeof window !== 'undefined') window.AudioTracks = AudioTracks;
if (typeof module !== 'undefined') module.exports = AudioTracks;
