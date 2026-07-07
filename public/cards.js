/* Renders Hungarian "Tell pattern" cards using cropped photos of the
 * traditional deck (public/cards_img/*.png — see public/cards_img/CREDIT.txt
 * for sources/licenses: number and court cards are CC BY-SA 4.0, photo by
 * SZERVÁC Attila via Wikimedia Commons; aces are the 1860 Sürch & Neumayer
 * engraving, public domain). Card backs are a plain CSS pattern, unrelated
 * to either source. Browser global: window.Cards
 */
(function () {
  'use strict';

  function parse(cardId) {
    const i = cardId.indexOf('-');
    return { suit: cardId.slice(0, i), rank: cardId.slice(i + 1) };
  }

  // A full playing card as HTML. opts: { selectable, disabled, small, selected }
  function cardHTML(cardId, opts) {
    opts = opts || {};
    const { suit, rank } = parse(cardId);
    const cls = [
      'card',
      'suit-' + suit,
      opts.selectable ? 'selectable' : '',
      opts.disabled ? 'disabled' : '',
      opts.small ? 'small' : '',
      opts.selected ? 'selected' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const aceClass = rank === 'Asz' ? ' ace-img' : '';
    return (
      '<div class="' + cls + '" data-card="' + cardId + '">' +
      '<img class="card-photo' + aceClass + '" src="cards_img/' + suit + '-' + rank + '.png" alt="' + suit + ' ' + rank + '" draggable="false">' +
      '</div>'
    );
  }

  function cardBackHTML(opts) {
    opts = opts || {};
    return '<div class="card card-back ' + (opts.small ? 'small' : '') + '"><span></span></div>';
  }

  window.Cards = { cardHTML, cardBackHTML, parse };
})();
