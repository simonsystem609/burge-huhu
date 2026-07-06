/* Renders Hungarian "Tell pattern" cards as self-contained SVG/HTML.
 * Original illustrations inspired by the traditional Magyar kártya /
 * Hungarian-Seasons pattern (double-headed courts, seasonal aces, classic
 * pip layouts for VII-X) — hand-drawn here, not a trace of any specific
 * manufacturer's artwork.
 * Browser global: window.Cards
 */
(function () {
  'use strict';

  const RANK_CODE = {
    VII: 'VII', VIII: 'VIII', IX: 'IX', X: 'X',
    Also: 'A', Felso: 'F', Kiraly: 'K', Asz: 'Á',
  };

  // Suit pip icon paths, 0..100 viewBox.
  const SUIT_PATH = {
    piros:
      'M50 86 C 20 62, 8 42, 20 26 C 30 13, 46 16, 50 30 C 54 16, 70 13, 80 26 C 92 42, 80 62, 50 86 Z',
    zold:
      'M50 12 C 78 30, 84 62, 52 88 C 52 70, 60 52, 70 40 C 56 50, 50 66, 50 88 C 50 66, 44 50, 30 40 C 40 52, 48 70, 48 88 C 16 62, 22 30, 50 12 Z',
    makk:
      'M50 90 C 30 90, 26 66, 30 50 C 34 38, 66 38, 70 50 C 74 66, 70 90, 50 90 Z M28 44 C 28 30, 72 30, 72 44 C 72 50, 28 50, 28 44 Z M50 26 L50 16',
    tok:
      'M50 14 a5 5 0 0 1 5 5 C 70 24, 72 48, 74 66 C 75 74, 82 74, 82 80 L18 80 C18 74, 25 74, 26 66 C 28 48, 30 24, 45 24 a5 5 0 0 1 5 -5 Z M42 84 a8 6 0 0 0 16 0 Z',
  };

  const SUIT_HEX = { piros: '#c23a4e', zold: '#2f8f4e', makk: '#8a5a2b', tok: '#d9a12a' };

  // ── One-time global <defs> with reusable pip symbols ─────────────────
  let defsReady = false;
  function ensureDefs() {
    if (defsReady) return;
    defsReady = true;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
    wrap.setAttribute('aria-hidden', 'true');
    const symbols = Object.keys(SUIT_PATH)
      .map((s) => `<symbol id="pip-${s}" viewBox="0 0 100 100"><path d="${SUIT_PATH[s]}"/></symbol>`)
      .join('');
    wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${symbols}</defs></svg>`;
    document.body.appendChild(wrap);
  }

  function parse(cardId) {
    const i = cardId.indexOf('-');
    return { suit: cardId.slice(0, i), rank: cardId.slice(i + 1) };
  }

  function pipUse(suit, x, y, size) {
    // fill="currentColor" resolves against the ancestor .card.suit-XXX { color } rule.
    return `<use href="#pip-${suit}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" fill="currentColor"/>`;
  }

  function suitIcon(suit, cls) {
    return (
      '<svg class="suit-icon ' + (cls || '') + '" viewBox="0 0 100 100" ' +
      'aria-hidden="true"><path d="' + SUIT_PATH[suit] + '"/></svg>'
    );
  }

  // ── Number cards: classic symmetric pip layouts (VII–X) ──────────────
  // Coordinates as [nx, ny] fractions of the inner field; mapped below.
  const COL_L = 0.16, COL_R = 0.84, COL_C = 0.5;
  const RANK_PIPS = {
    VII: [
      [COL_L, 0.13], [COL_R, 0.13],
      [COL_C, 0.30],
      [COL_L, 0.5], [COL_R, 0.5],
      [COL_L, 0.87], [COL_R, 0.87],
    ],
    VIII: [
      [COL_L, 0.11], [COL_R, 0.11],
      [COL_L, 0.37], [COL_R, 0.37],
      [COL_L, 0.63], [COL_R, 0.63],
      [COL_L, 0.89], [COL_R, 0.89],
    ],
    IX: [
      [COL_L, 0.11], [COL_R, 0.11],
      [COL_L, 0.37], [COL_R, 0.37],
      [COL_C, 0.5],
      [COL_L, 0.63], [COL_R, 0.63],
      [COL_L, 0.89], [COL_R, 0.89],
    ],
    X: [
      [COL_L, 0.10], [COL_R, 0.10],
      [COL_L, 0.34], [COL_R, 0.34],
      [COL_C, 0.40], [COL_C, 0.60],
      [COL_L, 0.66], [COL_R, 0.66],
      [COL_L, 0.90], [COL_R, 0.90],
    ],
  };

  function numberCardArt(suit, rank) {
    ensureDefs();
    const pips = RANK_PIPS[rank] || [];
    const fieldX0 = 20, fieldX1 = 80, fieldY0 = 14, fieldY1 = 126;
    const size = 15;
    const inner = pips
      .map(([nx, ny]) => {
        const x = fieldX0 + nx * (fieldX1 - fieldX0);
        const y = fieldY0 + ny * (fieldY1 - fieldY0);
        return pipUse(suit, x, y, size);
      })
      .join('');
    return `<svg class="face-art" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
  }

  // ── Court cards: double-headed bust, headwear marks the rank ─────────
  function bustHalf(suit, rank) {
    const hex = SUIT_HEX[suit];
    const skin = '#f0c9a0';
    let headwear = '';
    let face = `<circle cx="50" cy="6" r="1.3" fill="#2a2118"/>`; // placeholder overwritten below per rank

    if (rank === 'Kiraly') {
      headwear = `
        <path d="M37,20 L39,9 L45,15 L50,7 L55,15 L61,9 L63,20 Z" fill="#d9a441" stroke="#8a6a1a" stroke-width="0.8"/>
        <circle cx="50" cy="9" r="2.1" fill="#c23a4e"/>`;
      face = `
        <circle cx="45.5" cy="30" r="1.3" fill="#2a2118"/>
        <circle cx="54.5" cy="30" r="1.3" fill="#2a2118"/>
        <path d="M43,37 Q50,40.5 57,37" stroke="#3a2a1a" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    } else if (rank === 'Felso') {
      headwear = `
        <ellipse cx="50" cy="19" rx="19" ry="4.6" fill="${hex}" stroke="#2a2118" stroke-width="0.6"/>
        <ellipse cx="49" cy="11" rx="12" ry="8.5" fill="${hex}" stroke="#2a2118" stroke-width="0.6"/>
        <path d="M58,8 Q72,2 70,14 Q66,10 58,12" fill="#f4ecd8" stroke="#c9bd9a" stroke-width="0.5"/>`;
      face = `
        <circle cx="45.5" cy="30" r="1.3" fill="#2a2118"/>
        <circle cx="54.5" cy="30" r="1.3" fill="#2a2118"/>
        <path d="M44,37 Q50,39.5 56,37" stroke="#3a2a1a" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
    } else {
      // Also
      headwear = `
        <ellipse cx="50" cy="16.5" rx="11.5" ry="7.5" fill="${hex}" stroke="#2a2118" stroke-width="0.6"/>
        <rect x="39" y="20" width="22" height="3" rx="1.5" fill="#2a2118" opacity="0.35"/>`;
      face = `
        <circle cx="45.5" cy="30" r="1.3" fill="#2a2118"/>
        <circle cx="54.5" cy="30" r="1.3" fill="#2a2118"/>`;
    }

    return `
      <path d="M31,70 L35,48 Q50,42 65,48 L69,70 Z" fill="${hex}" stroke="#2a2118" stroke-width="0.7"/>
      <path d="M42,49 Q50,55 58,49 L58,53 Q50,59 42,53 Z" fill="#f4ecd8"/>
      <rect x="46" y="24" width="8" height="12" fill="${skin}"/>
      <circle cx="50" cy="30" r="12.5" fill="${skin}" stroke="#8a6a4a" stroke-width="0.6"/>
      ${headwear}
      ${face}
      ${pipUse(suit, 50, 62, 11)}
    `;
  }

  function courtCardArt(suit, rank) {
    ensureDefs();
    const half = bustHalf(suit, rank);
    return `<svg class="face-art" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">
      <g>${half}</g>
      <g transform="rotate(180 50 70)">${half}</g>
    </svg>`;
  }

  // ── Aces: seasonal emblem (Tavasz/Nyár/Ősz/Tél), double-headed ───────
  function seasonHalf(suit) {
    if (suit === 'piros') {
      // Tavasz — spring blossom
      return `
        <path d="M50,66 L50,38" stroke="#3f7d3a" stroke-width="2" fill="none"/>
        <ellipse cx="41" cy="55" rx="6" ry="3" fill="#3f7d3a" transform="rotate(-30 41 55)"/>
        <ellipse cx="59" cy="55" rx="6" ry="3" fill="#3f7d3a" transform="rotate(30 59 55)"/>
        ${[0, 60, 120, 180, 240, 300]
          .map(
            (a) =>
              `<ellipse cx="50" cy="26" rx="7" ry="4" fill="#e37b95" stroke="#b23a5a" stroke-width="0.4" transform="rotate(${a} 50 33)"/>`
          )
          .join('')}
        <circle cx="50" cy="33" r="3.4" fill="#f0c23a"/>
        ${pipUse('piros', 20, 14, 13)}
        ${pipUse('piros', 80, 14, 13)}
      `;
    }
    if (suit === 'tok') {
      // Nyár — summer sun & wheat
      return `
        <circle cx="50" cy="17" r="8" fill="#f0b429" stroke="#c98a12" stroke-width="0.6"/>
        ${[0, 45, 90, 135, 180, 225, 270, 315]
          .map((a) => `<rect x="49" y="4" width="2" height="5" fill="#f0b429" transform="rotate(${a} 50 17)"/>`)
          .join('')}
        <path d="M50,68 L50,40" stroke="#8a6a2b" stroke-width="1.6"/>
        <path d="M50,68 L38,42" stroke="#8a6a2b" stroke-width="1.4"/>
        <path d="M50,68 L62,42" stroke="#8a6a2b" stroke-width="1.4"/>
        <ellipse cx="50" cy="38" rx="3" ry="6" fill="#e0a52a"/>
        <ellipse cx="38" cy="40" rx="3" ry="6" fill="#e0a52a" transform="rotate(-18 38 40)"/>
        <ellipse cx="62" cy="40" rx="3" ry="6" fill="#e0a52a" transform="rotate(18 62 40)"/>
        <rect x="45" y="54" width="10" height="4" rx="1.5" fill="#8a5a2b"/>
        ${pipUse('tok', 20, 14, 13)}
        ${pipUse('tok', 80, 14, 13)}
      `;
    }
    if (suit === 'zold') {
      // Ősz — autumn grapes & barrel
      return `
        <rect x="39" y="48" width="22" height="17" rx="4" fill="#8a5a2b" stroke="#5a3a1a" stroke-width="0.6"/>
        <line x1="39" y1="53" x2="61" y2="53" stroke="#5a3a1a" stroke-width="1"/>
        <line x1="39" y1="60" x2="61" y2="60" stroke="#5a3a1a" stroke-width="1"/>
        <path d="M50,48 L50,32" stroke="#3f7d3a" stroke-width="1.6"/>
        ${[
          [44, 34], [56, 34], [41, 41], [50, 41], [59, 41], [47, 27], [53, 27],
        ]
          .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="3.6" fill="#7a4f9e" stroke="#4a2f6e" stroke-width="0.3"/>`)
          .join('')}
        <path d="M40,26 C34,20 40,12 48,18 C46,24 44,26 40,26 Z" fill="#3f7d3a"/>
        ${pipUse('zold', 20, 14, 13)}
        ${pipUse('zold', 80, 14, 13)}
      `;
    }
    // makk — Tél — winter snowflake & branch
    return `
      <path d="M50,68 Q48,54 50,44 Q52,34 46,26" stroke="#6a4a2a" stroke-width="1.8" fill="none"/>
      <path d="M50,52 Q58,48 62,40" stroke="#6a4a2a" stroke-width="1.3" fill="none"/>
      <path d="M49,40 Q42,36 38,28" stroke="#6a4a2a" stroke-width="1.3" fill="none"/>
      ${pipUse('makk', 62, 36, 13)}
      ${pipUse('makk', 37, 24, 13)}
      ${[0, 60, 120, 180, 240, 300]
        .map((a) => `<line x1="50" y1="10" x2="50" y2="20" stroke="#bcd8ea" stroke-width="1.4" transform="rotate(${a} 50 15)"/>`)
        .join('')}
      <circle cx="50" cy="15" r="1.4" fill="#eaf6fb"/>
    `;
  }

  function aceCardArt(suit) {
    ensureDefs();
    const half = seasonHalf(suit);
    return `<svg class="face-art" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">
      <g>${half}</g>
      <g transform="rotate(180 50 70)">${half}</g>
    </svg>`;
  }

  function faceArt(suit, rank) {
    if (rank === 'Asz') return aceCardArt(suit);
    if (rank === 'Also' || rank === 'Felso' || rank === 'Kiraly') return courtCardArt(suit, rank);
    return numberCardArt(suit, rank);
  }

  // A full playing card as HTML. opts: { selectable, disabled, small }
  function cardHTML(cardId, opts) {
    opts = opts || {};
    const { suit, rank } = parse(cardId);
    const code = RANK_CODE[rank] || rank;
    const cls = [
      'card',
      'suit-' + suit,
      opts.selectable ? 'selectable' : '',
      opts.disabled ? 'disabled' : '',
      opts.small ? 'small' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      '<div class="' + cls + '" data-card="' + cardId + '">' +
      '<span class="corner tl"><b>' + code + '</b>' + suitIcon(suit, 'mini') + '</span>' +
      '<span class="pip">' + faceArt(suit, rank) + '</span>' +
      '<span class="corner br"><b>' + code + '</b>' + suitIcon(suit, 'mini') + '</span>' +
      '</div>'
    );
  }

  function cardBackHTML(opts) {
    opts = opts || {};
    return '<div class="card card-back ' + (opts.small ? 'small' : '') + '"><span></span></div>';
  }

  window.Cards = { cardHTML, cardBackHTML, suitIcon, RANK_CODE, parse };
})();
