// Small helpers that fill in or check form fields as people type, with nothing sent anywhere (no outside lookups).
// Used by my-profile.html; plain functions so they can be tested in Node too.

/** US phone as (414) 213-4642 while typing; anything that is not a 10-digit US number is left as typed. */
export function formatPhone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length > 10 || /[a-z]/i.test(String(value || ''))) return String(value || '');
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Formats a phone box as the person types, keeping the cursor at the end (typing happens at the end almost always). */
export function livePhone(input) {
  if (!input) return;
  input.addEventListener('input', (e) => {
    if (e.inputType && e.inputType.startsWith('delete')) return; // let people delete freely
    const next = formatPhone(input.value);
    if (next !== input.value) input.value = next;
  });
  input.addEventListener('blur', () => { input.value = formatPhone(input.value); });
}

// The first three digits of a ZIP code tell the state (US Postal Service ranges). Ranges are inclusive.
const ZIP3 = [
  [5, 5, 'NY'], [6, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'], [60, 69, 'CT'],
  [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'],
  [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 339, 'FL'],
  [341, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'],
  [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [569, 569, 'DC'], [570, 577, 'SD'],
  [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 715, 'LA'],
  [716, 729, 'AR'], [730, 732, 'OK'], [733, 733, 'TX'], [734, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'],
  [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'],
  [967, 968, 'HI'], [969, 969, 'GU'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK']
];
/** The state for a ZIP code, or '' when it cannot be told (military, unknown or too short). */
export function stateForZip(zip) {
  const m = /^(\d{3})\d{2}(-?\d{4})?$/.exec(String(zip || '').trim());
  if (!m) return '';
  const n = Number(m[1]);
  const hit = ZIP3.find(([a, b]) => n >= a && n <= b);
  return hit ? hit[2] : '';
}

/** ABA routing number check digit: 3, 7, 1 weights over the 9 digits must add up to a multiple of 10. */
export function routingLooksRight(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = d.split('').reduce((s, c, i) => s + Number(c) * w[i], 0);
  return sum % 10 === 0 && !/^0{9}$/.test(d);
}

/** Choices offered under a box (a <datalist>); people can still type anything else. */
export const CHOICES = {
  en: {
    relationship: ['Spouse', 'Partner', 'Mother', 'Father', 'Parent', 'Son', 'Daughter', 'Brother', 'Sister', 'Friend', 'Roommate'],
    legalName: ['Married', 'Divorced', 'Spelling fix', 'Legal name change'],
    homeAddress: ['Moved', 'Spelling fix', 'New apartment number'],
    bankDetails: ['New bank', 'New account at the same bank', 'Account closed']
  },
  es: {
    relationship: ['Esposo(a)', 'Pareja', 'Madre', 'Padre', 'Hijo', 'Hija', 'Hermano', 'Hermana', 'Amigo(a)', 'Compañero(a) de casa'],
    legalName: ['Me casé', 'Me divorcié', 'Corrección de ortografía', 'Cambio legal de nombre'],
    homeAddress: ['Me mudé', 'Corrección de ortografía', 'Nuevo número de apartamento'],
    bankDetails: ['Banco nuevo', 'Cuenta nueva en el mismo banco', 'Cuenta cerrada']
  }
};

/** Puts a datalist with these choices under an input. */
export function offerChoices(input, id, choices) {
  if (!input) return;
  let list = document.getElementById(id);
  if (!list) { list = document.createElement('datalist'); list.id = id; document.body.appendChild(list); }
  list.replaceChildren(...choices.map((c) => { const o = document.createElement('option'); o.value = c; return o; }));
  input.setAttribute('list', id);
}

/** The mobile number typed on the sign-in page in this browser (login.js remembers it), or ''. */
export function phoneFromSignin() {
  try { const s = JSON.parse(localStorage.getItem('onnhr_code_way') || '{}'); return s && s.phone ? String(s.phone) : ''; } catch (_) { return ''; }
}
/** Remembers a saved mobile number for the sign-in page in this browser. */
export function rememberPhoneForSignin(phone) {
  try {
    const s = JSON.parse(localStorage.getItem('onnhr_code_way') || '{}') || {};
    localStorage.setItem('onnhr_code_way', JSON.stringify({ ...s, phone: String(phone || '').slice(0, 20) }));
  } catch (_) { /* private window */ }
}
