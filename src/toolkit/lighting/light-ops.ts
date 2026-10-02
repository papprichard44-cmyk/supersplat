import { LightState, StudioLight } from './studio-light';
import { Scene } from '../../scene';

// undo / redo operations of the studio, plugged into the editor's history
// through 'edit.add' (combine several with the editor's MultiOp)

class AddLightOp {
    name = 'toolkitAddLight';
    constructor(private scene: Scene, public light: StudioLight) {}

    async do() {
        await this.scene.add(this.light);
    }

    undo() {
        this.scene.remove(this.light);
    }
}

class RemoveLightOp {
    name = 'toolkitRemoveLight';
    constructor(private scene: Scene, public light: StudioLight) {}

    do() {
        this.scene.remove(this.light);
    }

    async undo() {
        await this.scene.add(this.light);
    }
}

class LightStateOp {
    name = 'toolkitLightState';
    constructor(public light: StudioLight, private oldState: LightState, private newState: LightState) {}

    private apply(state: LightState) {
        this.light.setState(state);
        this.light.scene?.events.fire('toolkit.light.changed', this.light);
    }

    do() {
        this.apply(this.newState);
    }

    undo() {
        this.apply(this.oldState);
    }
}

// studio-wide settings (exposure, ambient, bake quality, ...)
class StudioSettingsOp<T> {
    name = 'toolkitStudioSettings';
    constructor(private apply: (settings: T) => void, private oldSettings: T, private newSettings: T) {}

    do() {
        this.apply(this.newSettings);
    }

    undo() {
        this.apply(this.oldSettings);
    }
}

export { AddLightOp, RemoveLightOp, LightStateOp, StudioSettingsOp };
