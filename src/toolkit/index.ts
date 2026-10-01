import type { Container } from '@playcanvas/pcui';

import type { Events } from '../events';
import type { Scene } from '../scene';
import type { ToolManager } from '../tools/tool-manager';
import type { Tooltips } from '../ui/tooltips';
import { meshPrimitivesModule } from './mesh-primitives';

// Everything the toolkit adds on top of upstream SuperSplat lives in this
// directory. Upstream files only gain the hooks that call into it (main.ts,
// doc.ts), which keeps merges from playcanvas/supersplat cheap.

type ToolkitContext = {
    events: Events;
    scene: Scene;
    toolManager: ToolManager;
    canvasContainer: Container;
    tooltips: Tooltips;
};

// A toolkit feature. New features - including wrappers around community tools -
// are added by writing a module and listing it below.
interface ToolkitModule {
    id: string;
    init(ctx: ToolkitContext): void;
    // state stored in / restored from the project file (.ssproj)
    serialize?(): unknown;
    deserialize?(data: unknown): void | Promise<void>;
}

const modules: ToolkitModule[] = [
    meshPrimitivesModule
];

const initToolkit = (ctx: ToolkitContext) => {
    modules.forEach(module => module.init(ctx));

    ctx.events.function('docSerialize.toolkit', () => {
        const result: Record<string, unknown> = {};
        modules.forEach((module) => {
            if (module.serialize) {
                result[module.id] = module.serialize();
            }
        });
        return result;
    });

    ctx.events.function('docDeserialize.toolkit', async (data: Record<string, unknown> | undefined) => {
        for (const module of modules) {
            if (module.deserialize) {
                await module.deserialize(data?.[module.id]);
            }
        }
    });
};

export { initToolkit, ToolkitContext, ToolkitModule };
