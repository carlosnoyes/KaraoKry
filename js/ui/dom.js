// Tiny DOM helpers shared by the screens.

/** Collects every [data-ref] element under root into an object keyed by ref name. */
export function refs(root) {
  const out = {};
  for (const el of root.querySelectorAll('[data-ref]')) out[el.dataset.ref] = el;
  return out;
}

/** "Song 7 of 24" */
export function songProgress(round, total) {
  return `Song ${round + 1} of ${total}`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Shows `img` with `url`, or the placeholder element when there is none or it fails to load. */
export function showImage(img, placeholder, url) {
  img.onerror = () => {
    img.hidden = true;
    placeholder.hidden = false;
  };
  img.onload = () => {
    img.hidden = false;
    placeholder.hidden = true;
  };
  if (url) {
    img.hidden = false;
    placeholder.hidden = true;
    img.src = url;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    placeholder.hidden = false;
  }
}

export const ICONS = {
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
