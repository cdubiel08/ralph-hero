# Reference: Prototyping

Two sub-shapes share this reference. Both are **Interactive-tier** — read
`assets/interactive.css` and inline it after `theme.css`.

**Canon:** <https://thariqs.github.io/html-effectiveness/07-prototype-animation.html> (animation
sandbox) · <https://thariqs.github.io/html-effectiveness/08-prototype-interaction.html>
(clickable / drag flow)
**JS budget:** Interactive (≤ ~60 lines).

Motion and interaction can't be described, only felt. The artifact runs the real thing so the user
reacts to it in five seconds instead of imagining it from a paragraph. Keep fidelity
throwaway — polish is the implementer's job.

---

## (a) Animation sandbox

**Trigger:** "prototype this transition", "tune the easing", "show the micro-interaction so I can
feel it".

**Anatomy:** a **`.bench`** wrapper containing a `.stage` (the real animated element runs here),
an `.ease-row` of `.ease-btn` presets (one carries `.active`), an optional `.timeline` `.track`
with keyframe `.key` markers, and a `.snippet` echoing the CSS/keyframes. JS swaps the easing/
duration and replays.

```html
<div class="bench">
  <div class="stage"><div id="card" class="card" style="padding:20px">Task done ✓</div></div>
  <div class="ease-row">
    <button class="ease-btn active" data-ease="cubic-bezier(.2,.8,.2,1)">Smooth</button>
    <button class="ease-btn" data-ease="cubic-bezier(.34,1.56,.64,1)">Overshoot</button>
    <button class="ease-btn" data-ease="linear">Linear</button>
  </div>
</div>
<script>
const card = document.getElementById('card');
function play(ease){
  card.style.transition = 'none'; card.style.transform = 'scale(.85)'; card.style.opacity = '.4';
  requestAnimationFrame(() => {
    card.style.transition = `transform 420ms ${ease}, opacity 420ms ${ease}`;
    card.style.transform = 'scale(1)'; card.style.opacity = '1';
  });
}
document.querySelectorAll('.ease-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.ease-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); play(b.dataset.ease);
}));
play('cubic-bezier(.2,.8,.2,1)');
</script>
```

---

## (b) Clickable / drag-to-reorder flow

**Trigger:** "prototype this interaction", "let me feel the reorder", "mock the click-through".

**Anatomy:** a **`.bench`** holding a `.proto-list` of `.proto-item` rows (each a `.grip` handle +
label + optional `.count`), using native `draggable="true"`. A dragged item gets `.dragging`; the
row under the cursor gets `.drop-target`. Pair the bench with a short `.lede`/notes block stating
what the prototype is testing.

```html
<div class="bench"><div class="proto-list" id="list">
  <div class="proto-item" draggable="true"><span class="grip">⠿</span>Inbox<span class="count">12</span></div>
  <div class="proto-item" draggable="true"><span class="grip">⠿</span>Starred<span class="count">3</span></div>
  <div class="proto-item" draggable="true"><span class="grip">⠿</span>Archive<span class="count">88</span></div>
</div></div>
<script>
const list = document.getElementById('list');
let dragged = null;
list.addEventListener('dragstart', e => { dragged = e.target.closest('.proto-item'); dragged.classList.add('dragging'); });
list.addEventListener('dragend', () => { dragged.classList.remove('dragging'); list.querySelectorAll('.proto-item').forEach(i => i.classList.remove('drop-target')); });
list.addEventListener('dragover', e => {
  e.preventDefault();
  const over = e.target.closest('.proto-item');
  if (!over || over === dragged) return;
  list.querySelectorAll('.proto-item').forEach(i => i.classList.remove('drop-target'));
  over.classList.add('drop-target');
  const rect = over.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  list.insertBefore(dragged, after ? over.nextSibling : over);
});
</script>
```

> This is at the top of the interactive budget. If you need a Save/export-to-markdown step,
> persisted columns, or dependency logic, that's the deferred *editor* tier — build the prototype
> shape here and say the export piece is out of scope.

## Anti-patterns (group, each with why)

- **Don't describe motion in prose.** The entire value is that it runs; a paragraph about easing
  is exactly what the prototype replaces.
- **Don't reach for a framework or a drag library.** Native `draggable` + a few listeners is
  enough and keeps the file self-contained.
- **Don't over-polish.** Throwaway fidelity is the point — the prototype answers "does this feel
  right?", not "is this production-ready?".
- **Don't add an export/save button.** That tips the artifact into editor territory (deferred).
  Keep prototypes about *feel*, not state capture.
