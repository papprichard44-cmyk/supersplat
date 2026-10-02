import { Container, Element, Label } from '@playcanvas/pcui';

// Kept for callers: tooltips used to open beside their target in this
// direction. They now all appear in one place (the top right corner), so
// they never cover the controls being used and are never hidden behind a
// panel or dialog.
type Direction = 'left' | 'right' | 'top' | 'bottom';

// Tooltip text may be a static string or a resolver. A resolver is evaluated
// each time the tooltip is shown, so localized tooltips always reflect the
// current language without any language-change listener.
type TooltipText = string | (() => string);

// hover this long before a tooltip appears; once one is showing, moving to
// another control swaps it straight away
const SHOW_DELAY = 300;
// how long it lingers after the pointer leaves (so moving between controls
// doesn't make it flicker)
const HIDE_DELAY = 350;

// a short heading for the card: the control's own caption, or the label of
// the row it sits in
const headingOf = (dom: HTMLElement, text: string) => {
    let heading = '';
    const own = dom.textContent?.trim() ?? '';
    if (own && own.length <= 28 && !own.includes('\n')) {
        heading = own;
    } else {
        const row = dom.closest('.toolkit-row');
        const label = row?.querySelector('.toolkit-label');
        heading = label?.textContent?.trim() ?? '';
    }
    heading = heading.replace(/[…:.]+$/, '');
    // no heading when it would be all there is to read
    if (!heading || heading.length > 28 || text.length <= heading.length + 12) {
        return '';
    }
    return heading;
};

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

class Tooltips extends Container {
    register: (target: Element, text: TooltipText, direction?: Direction) => void;
    unregister: (target: Element) => void;
    destroy: () => void;

    constructor(args: any = {}) {
        args = {
            ...args,
            class: 'tooltips'
        };

        super(args);

        const heading = new Label({ class: 'tooltips-heading' });
        const text = new Label({ class: 'tooltips-content' });
        this.append(heading);
        this.append(text);

        const dom = this.dom;
        const targets = new Map<Element, any>();
        let timer = -1;
        let current: Element | null = null;

        const cancelTimer = () => {
            if (timer >= 0) {
                clearTimeout(timer);
                timer = -1;
            }
        };

        const hide = () => {
            cancelTimer();
            current = null;
            dom.classList.remove('visible');
        };

        const show = (target: Element, textString: TooltipText) => {
            // the target may have been destroyed or hidden while the timer ran
            if (!target.dom || !target.dom.isConnected) {
                return;
            }
            const value = typeof textString === 'function' ? textString() : textString;
            if (!value) {
                return;
            }
            current = target;
            heading.text = headingOf(target.dom, value);
            heading.hidden = !heading.text;
            text.text = value;

            // top right, unless that is where the control itself is: then
            // bottom right
            dom.classList.remove('lower');
            const card = dom.getBoundingClientRect();
            if (overlaps(card, target.dom.getBoundingClientRect())) {
                dom.classList.add('lower');
            }

            // restart the entrance when a new tooltip replaces a showing one
            if (dom.classList.contains('visible')) {
                dom.classList.remove('swap');
                dom.getBoundingClientRect(); // restart the animation
                dom.classList.add('swap');
            }
            dom.classList.add('visible');
        };

        this.register = (target: Element, textString: TooltipText, direction: Direction = 'bottom') => {
            const enter = () => {
                cancelTimer();
                if (dom.classList.contains('visible')) {
                    show(target, textString);
                } else {
                    timer = window.setTimeout(() => {
                        timer = -1;
                        show(target, textString);
                    }, SHOW_DELAY);
                }
            };

            const leave = () => {
                cancelTimer();
                if (dom.classList.contains('visible')) {
                    timer = window.setTimeout(hide, HIDE_DELAY);
                }
            };

            target.dom.addEventListener('pointerenter', enter);
            target.dom.addEventListener('pointerleave', leave);

            target.on('destroy', () => {
                this.unregister(target);
            });

            // keep our own dom reference: pcui nulls target.dom before firing
            // 'destroy', so unregister cannot read it from the target
            targets.set(target, { dom: target.dom, enter, leave });
        };

        this.unregister = (target: Element) => {
            const value = targets.get(target);
            if (value) {
                value.dom.removeEventListener('pointerenter', value.enter);
                value.dom.removeEventListener('pointerleave', value.leave);
                targets.delete(target);
            }
            if (current === target) {
                hide();
            }
        };

        this.destroy = () => {
            for (const target of targets.keys()) {
                this.unregister(target);
            }
        };
    }
}

export { Tooltips };
