// Line-art glyphs for the kinds of meshes: the add tiles of the Meshes panel
// and the type icons of its list. Drawn on a 24 px grid in currentColor, so
// they follow the theme and the hover / selected colours.

const glyphs: Record<string, string> = {
    plane: `
        <path d="M2.5 14.5 L12 18.8 L21.5 14.5 L12 10.2 Z"/>
        <path d="M7.2 12.4 L16.8 16.6 M16.8 12.4 L7.2 16.6" opacity=".35"/>`,
    wall: `
        <path d="M6.5 4 L17.5 6.5 V20 L6.5 17.5 Z"/>
        <path d="M3.5 19.5 L20.5 20.5" opacity=".45"/>`,
    box: `
        <path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"/>
        <path d="M4 7.5 L12 12 L20 7.5 M12 12 V21"/>`,
    sphere: `
        <circle cx="12" cy="12" r="8.5"/>
        <path d="M3.5 12 C 3.5 15.2, 20.5 15.2, 20.5 12"/>
        <path d="M3.5 12 C 3.5 8.8, 20.5 8.8, 20.5 12" opacity=".35"/>`,
    cylinder: `
        <ellipse cx="12" cy="6" rx="6.5" ry="2.6"/>
        <path d="M5.5 6 V18 C 5.5 21.4, 18.5 21.4, 18.5 18 V6"/>`,
    cone: `
        <path d="M12 3 L5 17.5 M12 3 L19 17.5"/>
        <path d="M5 17.5 C 5 21, 19 21, 19 17.5"/>
        <path d="M5 17.5 C 5 14.5, 19 14.5, 19 17.5" opacity=".35"/>`,
    torus: `
        <ellipse cx="12" cy="12.5" rx="9.5" ry="5.6"/>
        <path d="M7.6 12 C 8.8 9.8, 15.2 9.8, 16.4 12"/>
        <path d="M8.6 11.3 C 9.8 13.6, 14.2 13.6, 15.4 11.3"/>`,
    backdrop: `
        <path d="M3 19.5 H12.5 C 17 19.5, 19.5 17, 19.5 12.5 V3.5"/>
        <path d="M3 19.5 L5.5 16.5 H13 C 15.5 16.5, 16.5 15.2, 16.5 12.5 V3.5 L19.5 3.5" opacity=".45"/>`,
    image: `
        <rect x="3.5" y="5" width="17" height="14" rx="1.5"/>
        <path d="M3.5 16.5 L9 11.5 L13 15 L15.5 12.8 L20.5 17"/>
        <circle cx="16" cy="9" r="1.6"/>`,
    model: `
        <path d="M12 2.8 L19.5 7 V15.5 L12 19.7 L4.5 15.5 V7 Z"/>
        <path d="M4.5 7 L12 11.2 L19.5 7 M12 11.2 V19.7"/>
        <path d="M12 21.5 V23 M9.5 21.8 L12 23.3 L14.5 21.8" opacity=".6"/>`,
    tree: `
        <path d="M12 21 V13.5 M12 16 L9.5 13.8 M12 15 L14.5 12.8"/>
        <path d="M12 3 C 16.5 3, 18.5 6.5, 17.5 9.5 C 19 12, 16.5 14.5, 13.5 13.5 C 12.5 14.4, 10.5 14.4, 9.5 13.3 C 6.5 14, 4.8 11.2, 6.5 9 C 5.5 5.8, 8 3, 12 3 Z"/>`,
    grass: `
        <path d="M3 20.5 H21"/>
        <path d="M6 20.5 C 6 16, 5 13, 3.5 11 M9 20.5 C 9.5 15, 9 10, 8 6.5 M12 20.5 C 12 15.5, 13.5 11, 15.5 8.5 M15.5 20.5 C 16 17, 17.5 14.5, 20 13 M18.5 20.5 C 18.5 18.5, 19 17, 20.5 16"/>`,
    road: `
        <path d="M8.5 21 C 9.5 15, 6.5 11, 9 3 M15.5 21 C 16.5 15, 13.5 11, 16 3"/>
        <path d="M12 20 V17.5 M11.7 13.5 V11 M12.2 7 V4.8" opacity=".6"/>`,
    rocks: `
        <path d="M3.5 18.5 C 3 15, 5 11.5, 8.5 10.5 C 11 9.5, 13.5 11, 14 13.5 C 15 16.5, 13.5 18.5, 11 18.8 Z"/>
        <path d="M13.8 18.8 C 14.5 16, 16 14.8, 18 15 C 20 15.3, 21 17, 20.6 18.8 Z"/>
        <path d="M2.5 19 H21.5" opacity=".45"/>`
};

// the svg markup of a glyph, `size` px square
const primitiveIcon = (kind: string, size = 24) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${glyphs[kind] ?? glyphs.model}</svg>`;

export { primitiveIcon };
