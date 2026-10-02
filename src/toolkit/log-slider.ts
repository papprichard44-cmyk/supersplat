import { Container, NumericInput, SliderInput } from '@playcanvas/pcui';

// A slider for sizes and amounts that span orders of magnitude: the track is
// logarithmic (every step multiplies the value by the same factor), so small
// values get as much of the track as large ones. The number field shows the
// real value and takes any value typed in; the track's range is meant to be
// set from the scene's size (setRange), and stretches to a typed value.

const TRACK = 1000;

// a few significant digits, whatever the magnitude
const tidy = (v: number) => {
    if (!(v > 0)) return 0;
    const digits = Math.max(0, 2 - Math.floor(Math.log10(v)));
    return Number(v.toFixed(Math.min(6, digits)));
};

class LogSlider extends Container {
    private numeric: NumericInput;

    private track: SliderInput;

    private lo: number;

    private hi: number;

    private current: number;

    private updating = false;

    constructor(min: number, max: number, value: number) {
        super({ class: 'toolkit-log-slider' });
        this.lo = min;
        this.hi = max;
        this.current = value;
        this.numeric = new NumericInput({ class: 'toolkit-log-number', min: 1e-6, precision: 6, value, hideSlider: true });
        this.track = new SliderInput({ class: 'toolkit-log-track', min: 0, max: TRACK, precision: 0, step: 1, value: 0 });
        this.append(this.numeric);
        this.append(this.track);
        this.syncTrack();
        this.syncNumber();

        this.track.on('change', (t: number) => {
            if (this.updating) return;
            this.set(tidy(this.lo * Math.pow(this.hi / this.lo, t / TRACK)), false);
        });
        this.numeric.on('change', (v: number) => {
            if (this.updating) return;
            if (v > 0) this.set(v, true);
        });
    }

    private syncTrack() {
        const t = Math.log(this.current / this.lo) / Math.log(this.hi / this.lo);
        this.updating = true;
        this.track.value = Math.round(Math.min(1, Math.max(0, t)) * TRACK);
        this.updating = false;
    }

    private syncNumber() {
        this.updating = true;
        // as many decimals as the value needs, no more
        const digits = this.current > 0 ? Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(this.current)))) : 2;
        this.numeric.precision = digits;
        this.numeric.value = this.current;
        this.updating = false;
    }

    private set(v: number, fromNumber: boolean) {
        if (v === this.current) return;
        this.current = v;
        // a typed value outside the track's range stretches it
        if (fromNumber) {
            if (v < this.lo) this.lo = v;
            if (v > this.hi) this.hi = v;
            this.syncTrack();
        }
        this.syncNumber();
        this.emit('change', v);
    }

    // the track's span; the value keeps its place in it
    setRange(min: number, max: number) {
        this.lo = Math.max(1e-6, Math.min(min, this.current || min));
        this.hi = Math.max(this.lo * 1.01, max, this.current);
        this.syncTrack();
    }

    set value(v: number) {
        if (!(v > 0)) return;
        this.current = v;
        if (v < this.lo) this.lo = v;
        if (v > this.hi) this.hi = v;
        this.syncTrack();
        this.syncNumber();
    }

    get value() {
        return this.current;
    }
}

export { LogSlider };
