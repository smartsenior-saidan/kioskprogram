// slideshow.js — auto-advancing photo slideshow with touch-friendly controls.
//
// Opens a fullscreen overlay over the profile page. Play/pause, prev/next,
// keyboard arrows, and a counter. Logs a slideshow_play event on start.

import { logSlideshowPlay } from "./analytics.js";

const ADVANCE_MS = 4500;

export class Slideshow {
  /**
   * @param {string[]} imageUrls ordered photo URLs
   * @param {object} [opts] { personId }
   */
  constructor(imageUrls, opts = {}) {
    this.images = imageUrls.filter(Boolean);
    this.personId = opts.personId || null;
    this.index = 0;
    this.timer = null;
    this.playing = false;
    this.overlay = null;
  }

  // --- Lifecycle -----------------------------------------------------------

  open(startIndex = 0) {
    if (!this.images.length) return;
    this.index = Math.max(0, Math.min(startIndex, this.images.length - 1));
    this._build();
    document.body.appendChild(this.overlay);
    this._show(this.index);
    this.play();
    if (this.personId) logSlideshowPlay(this.personId);
  }

  close() {
    this.pause();
    document.removeEventListener("keydown", this._onKey);
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
  }

  // --- Playback ------------------------------------------------------------

  play() {
    if (this.images.length < 2) return;
    this.playing = true;
    this._updatePlayButton();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.next(), ADVANCE_MS);
  }

  pause() {
    this.playing = false;
    this._updatePlayButton();
    clearInterval(this.timer);
    this.timer = null;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  next() {
    this._show((this.index + 1) % this.images.length);
  }

  prev() {
    this._show((this.index - 1 + this.images.length) % this.images.length);
  }

  // --- Rendering -----------------------------------------------------------

  _show(i) {
    this.index = i;
    const slides = this.overlay.querySelectorAll(".slideshow-stage img");
    slides.forEach((img, idx) => img.classList.toggle("active", idx === i));
    const counter = this.overlay.querySelector(".slideshow-counter");
    if (counter) counter.textContent = `${i + 1} / ${this.images.length}`;
    // Restart the auto-advance window after a manual move so it feels natural.
    if (this.playing) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.next(), ADVANCE_MS);
    }
  }

  _updatePlayButton() {
    if (!this.overlay) return;
    const btn = this.overlay.querySelector('[data-action="toggle"]');
    if (btn) btn.textContent = this.playing ? "⏸" : "▶";
  }

  _build() {
    const overlay = document.createElement("div");
    overlay.className = "slideshow-overlay";

    const stage = document.createElement("div");
    stage.className = "slideshow-stage";
    this.images.forEach((url) => {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Memorial photo";
      stage.appendChild(img);
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "slideshow-close";
    closeBtn.setAttribute("aria-label", "Close slideshow");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());

    const controls = document.createElement("div");
    controls.className = "slideshow-controls";
    controls.innerHTML = `
      <button data-action="prev" aria-label="Previous photo">‹</button>
      <button data-action="toggle" aria-label="Play or pause">⏸</button>
      <span class="slideshow-counter"></span>
      <button data-action="next" aria-label="Next photo">›</button>`;

    controls
      .querySelector('[data-action="prev"]')
      .addEventListener("click", () => this.prev());
    controls
      .querySelector('[data-action="next"]')
      .addEventListener("click", () => this.next());
    controls
      .querySelector('[data-action="toggle"]')
      .addEventListener("click", () => this.toggle());

    overlay.appendChild(closeBtn);
    overlay.appendChild(stage);
    overlay.appendChild(controls);

    // Tap on backdrop (not the photo) closes.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    // Keyboard control.
    this._onKey = (e) => {
      if (e.key === "Escape") this.close();
      else if (e.key === "ArrowRight") this.next();
      else if (e.key === "ArrowLeft") this.prev();
      else if (e.key === " ") {
        e.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener("keydown", this._onKey);

    this.overlay = overlay;
  }
}

/** Convenience: create and open a slideshow in one call. */
export function startSlideshow(imageUrls, opts = {}) {
  const show = new Slideshow(imageUrls, opts);
  show.open(opts.startIndex || 0);
  return show;
}
