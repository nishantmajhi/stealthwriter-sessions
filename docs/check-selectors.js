/**
 * Paste into the browser console on the humanizer page to check whether the
 * extension's selectors still match. Run this first whenever restore or save
 * stops working after a site update.
 */
(() => {
  const ta   = document.querySelector('textarea[placeholder="Paste your AI-generated text here..."]');
  const h3   = [...document.querySelectorAll('h3')].find(h => h.textContent.trim() === 'Humanized Result');
  const card = h3?.closest('.rounded-xl');
  const out  = card?.querySelector('.whitespace-pre-wrap');

  console.table({
    textarea:        !!ta,
    heading:         !!h3,
    card:            !!card,
    output:          !!out,
    sentences:       out ? out.querySelectorAll('span[role="button"]').length : 0
  });

  if (!ta)          console.warn('Textarea placeholder changed - update SEL_TEXTAREA in content.js');
  if (!h3)          console.warn('Heading changed. Found:', [...document.querySelectorAll('h3')].map(h => h.textContent.trim()));
  if (h3 && !card)  console.warn('Card wrapper changed - update getOutputDiv() in content.js');
})();
