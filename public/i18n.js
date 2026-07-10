/* Bilingual strings + card naming for Bürge / Hühü. Browser global: window.I18N */
(function () {
  'use strict';

  const SUIT_NAME = {
    hu: { tok: 'Tök', makk: 'Makk', zold: 'Zöld', piros: 'Piros' },
    en: { tok: 'Bells', makk: 'Acorns', zold: 'Leaves', piros: 'Hearts' },
  };

  const RANK_NAME = {
    hu: {
      VII: 'VII', VIII: 'VIII', IX: 'IX', X: 'X',
      Also: 'Alsó', Felso: 'Felső', Kiraly: 'Király', Asz: 'Ász',
    },
    en: {
      VII: '7', VIII: '8', IX: '9', X: '10',
      Also: 'Under', Felso: 'Over', Kiraly: 'King', Asz: 'Ace',
    },
  };

  const STR = {
    hu: {
      title: 'Bürge · Hühü',
      subtitle: 'Magyar kártyajáték – 2–4 játékos',
      yourName: 'Neved',
      namePh: 'Írd be a neved',
      single: 'Egyjátékos (gépek ellen)',
      create: 'Szoba létrehozása',
      join: 'Csatlakozás',
      codePh: 'SZOBAKÓD',
      bots: 'Gépek száma',
      animSpeed: 'Animáció sebessége',
      animFast: 'Gyors',
      animNormal: 'Normál',
      animSlow: 'Lassú',
      botSpeed: 'Bot sebessége',
      botFast: 'Gyors',
      botNormal: 'Normál',
      botSlow: 'Lassú',
      language: 'Nyelv',
      rules: 'Szabályok',
      lobby: 'Váróterem',
      code: 'Kód',
      copy: 'Másol',
      copied: 'Másolva!',
      players: 'Játékosok',
      host: 'házigazda',
      you: 'te',
      addBot: 'Gép hozzáadása',
      startGame: 'Játék indítása',
      leave: 'Kilépés',
      waitingHost: 'Várakozás a házigazdára…',
      needPlayers: 'Legalább 2 játékos kell.',
      trump: 'Adu',
      talon: 'Húzópakli',
      discard: 'Dobott',
      yourTurn: 'Te jössz!',
      attackPrompt: 'Húzd ki a lapo(ka)t az asztalra: egyet, egy párt +1 kísérőt, vagy két párt +1 kísérőt, majd Küldés',
      defendPrompt: 'Tedd a lapjaid az ütendő lapokra, vagy jelöld őket felvételre — aztán Ütés',
      take: 'Felveszem',
      attackBtn: 'Küldés',
      beatBtn: 'Ütés',
      swap7: 'Adu VII csere',
      trumpPicked: 'Elvitték',
      pickupTag: 'felveszem',
      waitingFor: 'Vár: {name}',
      attacksYou: '{name} téged támad',
      over: 'Vége a játéknak',
      youWin: 'Nyertél! 🎉',
      youLose: 'Te lettél a bürge! 🙈',
      loserIs: '{name} lett a bürge.',
      draw: 'Döntetlen!',
      finishOrder: 'Sorrend',
      rematch: 'Új parti',
      menu: 'Főmenü',
      logTitle: 'Napló',
      trumpSuitIs: 'Adu szín: {suit}',
      // log lines
      log_game_start: 'Új parti. Adu: {trump}.',
      log_attack: '{p} támad: {card}.',
      log_defend: '{p} üt: {card}.',
      log_take: '{p} felvette: {card}.',
      log_swap7: '{p} adu VII-est cserélt.',
      log_player_out: '{p} kifogyott (#{rank}).',
      log_loser: '{p} lett a bürge.',
      log_stalled: 'Patthelyzet – a legtöbb lappal maradó veszít.',
      reconnected: 'Újracsatlakozva!',
      disconnected: 'Kapcsolat megszakadt. Újracsatlakozás…',
      // errors
      err_no_room: 'Nincs ilyen szoba.',
      err_full: 'A szoba tele van.',
      err_in_progress: 'A parti már elkezdődött.',
      err_need_players: 'Legalább 2 játékos kell.',
      err_already_in_room: 'Már egy szobában vagy.',
      err_not_your_turn: 'Nem te jössz.',
      err_does_not_beat: 'Ez a lap nem üti.',
      err_bad_set: 'Ez nem egy szabályos lap-kombináció.',
      err_generic: 'Hiba történt.',
      wrongGameUr: 'Ez a kód egy Royal Game of Ur szoba — átirányítás…',
    },
    en: {
      title: 'Bürge · Hühü',
      subtitle: 'Hungarian card game – 2–4 players',
      yourName: 'Your name',
      namePh: 'Enter your name',
      single: 'Singleplayer (vs bots)',
      create: 'Create room',
      join: 'Join',
      codePh: 'ROOM CODE',
      bots: 'Number of bots',
      animSpeed: 'Animation speed',
      animFast: 'Fast',
      animNormal: 'Normal',
      animSlow: 'Slow',
      botSpeed: 'Bot speed',
      botFast: 'Fast',
      botNormal: 'Normal',
      botSlow: 'Slow',
      language: 'Language',
      rules: 'Rules',
      lobby: 'Lobby',
      code: 'Code',
      copy: 'Copy',
      copied: 'Copied!',
      players: 'Players',
      host: 'host',
      you: 'you',
      addBot: 'Add bot',
      startGame: 'Start game',
      leave: 'Leave',
      waitingHost: 'Waiting for the host…',
      needPlayers: 'At least 2 players needed.',
      trump: 'Trump',
      talon: 'Draw pile',
      discard: 'Discard',
      yourTurn: 'Your turn!',
      attackPrompt: 'Drag card(s) onto the table: one, a pair +1 extra, or two pairs +1 extra, then Send',
      defendPrompt: 'Place cards on the attacks (or mark them for pickup), then press Beat',
      beatBtn: 'Beat',
      take: 'Pick up',
      attackBtn: 'Send',
      swap7: 'Swap trump VII',
      trumpPicked: 'Picked',
      pickupTag: 'picking up',
      waitingFor: 'Waiting: {name}',
      attacksYou: '{name} attacks you',
      over: 'Game over',
      youWin: 'You win! 🎉',
      youLose: 'You are the bürge! 🙈',
      loserIs: '{name} is the bürge.',
      draw: 'Draw!',
      finishOrder: 'Finishing order',
      rematch: 'Rematch',
      menu: 'Main menu',
      logTitle: 'Log',
      trumpSuitIs: 'Trump suit: {suit}',
      log_game_start: 'New game. Trump: {trump}.',
      log_attack: '{p} attacks: {card}.',
      log_defend: '{p} beats with {card}.',
      log_take: '{p} picked up: {card}.',
      log_swap7: '{p} swapped the trump VII.',
      log_player_out: '{p} is out (#{rank}).',
      log_loser: '{p} is the bürge.',
      log_stalled: 'Stalemate – whoever holds the most cards loses.',
      reconnected: 'Reconnected!',
      disconnected: 'Connection lost. Reconnecting…',
      err_no_room: 'No such room.',
      err_full: 'The room is full.',
      err_in_progress: 'The game already started.',
      err_need_players: 'At least 2 players needed.',
      err_already_in_room: 'You are already in a room.',
      err_not_your_turn: 'Not your turn.',
      err_does_not_beat: 'That card does not beat it.',
      err_bad_set: 'That is not a legal card combination.',
      err_generic: 'Something went wrong.',
      wrongGameUr: 'That code is a Royal Game of Ur room — taking you there…',
    },
  };

  function t(lang, key, params) {
    const table = STR[lang] || STR.hu;
    let s = table[key] != null ? table[key] : (STR.hu[key] != null ? STR.hu[key] : key);
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      }
    }
    return s;
  }

  function suitName(lang, suit) {
    return (SUIT_NAME[lang] || SUIT_NAME.hu)[suit] || suit;
  }

  function rankName(lang, rank) {
    return (RANK_NAME[lang] || RANK_NAME.hu)[rank] || rank;
  }

  function cardName(lang, cardId) {
    const i = cardId.indexOf('-');
    const suit = cardId.slice(0, i);
    const rank = cardId.slice(i + 1);
    return suitName(lang, suit) + ' ' + rankName(lang, rank);
  }

  window.I18N = { STR, t, suitName, rankName, cardName, SUIT_NAME, RANK_NAME };
})();
