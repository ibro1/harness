<form id="calc" novalidate>
  <div class="field">
    <label for="amount">Amount <span class="hint">What to enter, in plain words.</span></label>
    <input id="amount" name="amount" type="number" inputmode="decimal" min="0" step="any" required>
  </div>
  <div class="actions"><button type="submit">Calculate</button></div>
  <div class="result" id="result" aria-live="polite"></div>
  <noscript><p class="error">This calculator needs JavaScript, which runs only in your browser.</p></noscript>
</form>
