// Only the SDK boundary is mocked. Dialog lifecycle and plugin behavior are tested separately.
export class MockDialog {
    static instances = [];

    constructor(options) {
        this.options = options;
        this.element = document.createElement("div");
        this.element.innerHTML = `<div class="b3-dialog" style="z-index:100"><div class="b3-dialog__container" role="dialog" aria-modal="true" tabindex="-1"><div class="b3-dialog__body">${options.content}</div></div></div>`;
        document.body.append(this.element);
        MockDialog.instances.push(this);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.element.remove();
        this.options.destroyCallback?.();
    }
}
