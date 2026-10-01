import { Scene } from '../scene';
import { MeshPrimitive, PrimitiveState } from './mesh-primitive';

// undo/redo operations for mesh primitives. They plug into the editor's
// existing history through the 'edit.add' event.

class AddPrimitiveOp {
    name = 'toolkitAddPrimitive';
    constructor(private scene: Scene, public primitive: MeshPrimitive) {}

    async do() {
        await this.scene.add(this.primitive);
    }

    undo() {
        this.scene.remove(this.primitive);
    }
}

class RemovePrimitiveOp {
    name = 'toolkitRemovePrimitive';
    constructor(private scene: Scene, public primitive: MeshPrimitive) {}

    do() {
        this.scene.remove(this.primitive);
    }

    async undo() {
        await this.scene.add(this.primitive);
    }
}

class PrimitiveStateOp {
    name = 'toolkitPrimitiveState';
    constructor(
        public primitive: MeshPrimitive,
        private oldState: PrimitiveState,
        private newState: PrimitiveState
    ) {}

    private apply(state: PrimitiveState) {
        this.primitive.setState(state);
        this.primitive.scene?.events.fire('toolkit.primitive.changed', this.primitive);
    }

    do() {
        this.apply(this.newState);
    }

    undo() {
        this.apply(this.oldState);
    }
}

export { AddPrimitiveOp, RemovePrimitiveOp, PrimitiveStateOp };
