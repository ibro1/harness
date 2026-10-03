/**
 * The site's standing pages: About, Contact, Privacy and Terms. Privacy
 * states plainly what happens today (no cookies, no tracking, nothing sent)
 * and switches to the advertising disclosures Google requires once an
 * AdSense client is set in site.config.json.
 */

import { esc } from '../lib/render.mjs'

/**
 * The standing pages.
 * @param {any} config - site.config.json
 * @param {string} updated - `YYYY-MM-DD` the pages were last changed
 * @returns {{ path: string, title: string, description: string, h1: string, html: string }[]}
 */
export function standingPages(config, updated) {
  const ads = typeof config.adsenseClient === 'string' && config.adsenseClient !== ''
  const owner = `<a href="${esc(config.ownerUrl)}">${esc(config.owner)}</a>`
  const contact = config.contactEmail
    ? `email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a> or use <a href="${esc(config.contactUrl)}">the contact form</a>`
    : `use <a href="${esc(config.contactUrl)}">the contact form on linkfa.de</a>`
  return [
    {
      path: '/about/',
      title: `About ${config.name}`,
      description: `${config.name} builds free calculators that explain the rule behind every number and cite the official source they were checked against.`,
      h1: `About ${config.name}`,
      html: `<p>${esc(config.name)} is a small collection of free calculators and checkers made by ${owner}, a software studio. We build a tool only when people are searching for it and the existing answers are thin, hard to use, or do not show their working.</p>
<h2 id="how-we-build">How every tool is made</h2>
<ul>
<li><strong>It shows its working.</strong> Each page explains the rule the calculator follows, with a worked example you can check by hand.</li>
<li><strong>It cites its sources.</strong> Rates, thresholds and rules come from official or scholarly sources, linked on the page with the date we last checked them.</li>
<li><strong>It is tested.</strong> Every calculator's logic is checked against known answers before it is published, and again on every change.</li>
<li><strong>It stays on your device.</strong> Calculations run in your browser. Nothing you type is sent to us or anyone else.</li>
</ul>
<h2 id="limits">What the tools are not</h2>
<p>The tools help you understand and estimate. They are not financial, tax, legal or religious advice. For a decision that matters, such as dividing an estate or filing a tax return, confirm the result with a qualified adviser or scholar.</p>
<h2 id="corrections">Corrections</h2>
<p>If you find a mistake or a rule that has changed, please ${contact}. We fix errors and note the review date on the page.</p>`,
    },
    {
      path: '/contact/',
      title: `Contact ${config.name}`,
      description: `How to reach the team behind ${config.name}: report a mistake, suggest a calculator, or ask about a result.`,
      h1: 'Contact',
      html: `<p>To report a mistake, suggest a calculator or ask about a result, ${contact}. A person reads every message.</p>
<p>${esc(config.name)} is run by ${owner}.</p>
<p>When you report a problem with a result, include the page address and the numbers you entered. The tools do not send us your inputs, so we cannot see them otherwise.</p>`,
    },
    {
      path: '/privacy/',
      title: `Privacy policy · ${config.name}`,
      description: `What ${config.name} collects (nothing you type into a calculator), how cookies are used, and your choices about advertising.`,
      h1: 'Privacy policy',
      html: `<p>Last updated ${esc(updated)}. This policy covers ${esc(config.origin.replace(/^https:\/\//u, ''))}, run by ${owner}.</p>
<h2 id="inputs">What you type into a calculator</h2>
<p>Every calculation runs in your browser. The numbers and choices you enter are never sent to us or stored on our servers.</p>
<h2 id="logs">Server logs</h2>
<p>Like any website, our web server receives the standard request information your browser sends (IP address, browser type, the page requested and the time). We use it only to keep the site running and secure, and do not combine it with other data.</p>
<h2 id="cookies">Cookies and advertising</h2>
${ads
    ? `<p>This site shows advertising from Google AdSense. Google and its partners use cookies to serve ads based on your previous visits to this and other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visits to this site and/or other sites on the Internet.</p>
<p>You can opt out of personalised advertising in <a href="https://adssettings.google.com">Google's Ads Settings</a>, or opt out of some third-party vendors' use of cookies for personalised advertising at <a href="https://www.aboutads.info/choices/">aboutads.info</a>. See <a href="https://policies.google.com/technologies/partner-sites">how Google uses information from sites that use its services</a>.</p>
<p>Visitors in the UK, the European Economic Area and Switzerland are asked for consent before personalised ads are shown, through Google's consent message. You can change your choice at any time from the privacy link that message adds to the page.</p>`
    : '<p>This site does not currently use cookies, analytics or advertising. If we add advertising (such as Google AdSense) this section will be updated before it starts, to explain the cookies involved and how to opt out.</p>'}
<h2 id="links">Links to other sites</h2>
<p>Pages link to the official sources behind each calculation. Those sites have their own privacy policies.</p>
<h2 id="rights">Your rights and contact</h2>
<p>Under UK and EU data protection law you can ask what personal data we hold about you and ask us to delete it. To do so, ${contact}.</p>`,
    },
    {
      path: '/terms/',
      title: `Terms of use · ${config.name}`,
      description: `The terms for using ${config.name}: free to use, estimates only, not professional advice, and no warranty.`,
      h1: 'Terms of use',
      html: `<p>Last updated ${esc(updated)}. By using ${esc(config.name)} you agree to these terms.</p>
<h2 id="use">Using the tools</h2>
<p>The tools are free for personal and commercial use. Please do not copy the pages wholesale or present them as your own.</p>
<h2 id="no-advice">Estimates, not advice</h2>
<p>Results are estimates based on the rules and figures shown on each page, checked on the dates given. They are not financial, tax, legal or religious advice, and rules change. Confirm anything important with a qualified adviser or scholar before acting on it.</p>
<h2 id="warranty">No warranty</h2>
<p>We test every calculator against known answers, but we cannot promise the tools are free of errors. To the extent the law allows, ${esc(config.owner)} is not liable for loss arising from use of the site.</p>
<h2 id="changes">Changes</h2>
<p>We may update these terms; the date above shows the latest version. Questions: ${contact}.</p>`,
    },
  ]
}
