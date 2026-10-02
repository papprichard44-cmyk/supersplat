// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

import { granite } from './granite';
import { sandstone } from './sandstone';
import { basalt } from './basalt';
import { limestone } from './limestone';
import { volcanic } from './volcanic';
import { glacial } from './glacial';
import { riverCobble } from './river-cobble';
import { karst } from './karst';
import { schist } from './schist';
import { slate } from './slate';
import { crystal } from './crystal';
import { marble } from './marble';
import { obsidian } from './obsidian';
import { ore } from './ore';
import { ice } from './ice';

export const SPECIES = {
  granite,
  sandstone,
  basalt,
  limestone,
  volcanic,
  glacial,
  riverCobble,
  karst,
  schist,
  slate,
  crystal,
  marble,
  obsidian,
  ore,
  ice,
};

export const DEFAULT_SPECIES = 'karst';

export const SPECIES_LIST = Object.values(SPECIES);
