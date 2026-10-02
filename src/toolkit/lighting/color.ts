import { srgbToLinear } from './samples';

// Colour temperature of a light in kelvin -> linear rgb with a luminance of 1,
// so changing the temperature changes the colour but not the brightness.
// (Tanner Helland's fit of the black body curve, good from 1000 K to 40000 K.)
const kelvinToLinear = (kelvin: number): [number, number, number] => {
    const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
    let r: number, g: number, b: number;
    if (t <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(t) - 161.1195681661;
        b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
        r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
        b = 255;
    }
    const lin = [r, g, b].map(c => srgbToLinear(Math.min(255, Math.max(0, c)) / 255));
    const luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return [lin[0] / luminance, lin[1] / luminance, lin[2] / luminance];
};

// named colour temperatures, for the picker
const kelvinPresets = [
    { kelvin: 1900, label: 'Candle' },
    { kelvin: 2700, label: 'Household bulb' },
    { kelvin: 3200, label: 'Tungsten (film)' },
    { kelvin: 4300, label: 'Golden hour' },
    { kelvin: 5600, label: 'Daylight' },
    { kelvin: 6500, label: 'Overcast' },
    { kelvin: 8000, label: 'Blue shade' }
];

export { kelvinToLinear, kelvinPresets };
