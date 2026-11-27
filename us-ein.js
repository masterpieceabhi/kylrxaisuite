// Asks for the company's EIN in place, only when something needs it (a server answer with code "ein_needed").
// The EIN is normally filled from Gusto when the company connects; this is for companies that have not.
//   import { askEin } from './us-ein.js?v=1';
//   catch (err) { if (err.code === 'ein_needed' && await askEin({ message: err.message, save: (ein) => req('PUT', '/company/ein', { ein }) })) retry(); }
const digits = (v) => String(v || '').replace(/\D/g, '');
const pretty = (d) => (d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2, 9)}` : d);

/** Resolves true once the EIN is saved, false when the person closes the box. */
export function askEin({ message, save }) {
  return new Promise((resolve) => {
    const box = document.createElement('dialog');
    box.setAttribute('aria-labelledby', 'einTitle');
    box.style.cssText = 'max-width:440px;width:calc(100% - 32px);border:1px solid #d0d7de;border-radius:12px;padding:20px;font:inherit';
    box.innerHTML = `
      <form method="dialog" style="display:grid;gap:10px;margin:0">
        <h2 id="einTitle" style="margin:0;font-size:1.15rem">Your company's EIN</h2>
        <p data-msg style="margin:0;color:#57606a"></p>
        <label style="display:grid;gap:4px">EIN (9 digits)
          <input name="ein" inputmode="numeric" autocomplete="off" placeholder="12-3456789" maxlength="10" required style="font:inherit;padding:8px;border:1px solid #d0d7de;border-radius:8px">
        </label>
        <p style="margin:0;font-size:.9rem;color:#57606a">It is on your IRS letter (CP 575) and on any W-2 or Form 941 you have filed. You only enter it once.</p>
        <p data-err role="alert" style="margin:0;color:#cf222e"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" data-cancel class="ghost">Not now</button>
          <button type="submit" data-save>Save and continue</button>
        </div>
      </form>`;
    box.querySelector('[data-msg]').textContent = message || 'This needs your company\'s EIN (federal employer ID).';
    const input = box.querySelector('input'); const err = box.querySelector('[data-err]'); const btn = box.querySelector('[data-save]');
    input.addEventListener('input', () => { const d = digits(input.value).slice(0, 9); input.value = pretty(d); err.textContent = ''; });
    const done = (ok) => { box.close(); box.remove(); resolve(ok); };
    box.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    box.addEventListener('cancel', () => done(false));
    box.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = digits(input.value);
      if (d.length !== 9) { err.textContent = 'An EIN has 9 digits, for example 12-3456789.'; input.focus(); return; }
      if (d.startsWith('00')) { err.textContent = 'An EIN never starts with 00. Check the number on your IRS letter.'; input.focus(); return; }
      btn.disabled = true;
      try { await save(pretty(d)); done(true); } catch (x) { err.textContent = x.message || 'Could not save. Try again.'; btn.disabled = false; }
    });
    document.body.appendChild(box);
    box.showModal(); input.focus();
  });
}
