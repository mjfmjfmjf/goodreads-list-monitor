import { describe, expect, it } from 'vitest';
import { listHtmlUsable, isCaptchaPage } from './listWalker.js';

describe('listHtmlUsable', () => {
  it('accepts a real list page', () => {
    const page = `<html><body>${'<div class="bookalike review">Lorem ipsum dolor sit amet.</div>'.repeat(40)}</body></html>`;
    expect(listHtmlUsable(page)).toBe(true);
  });

  it('rejects empty / throttled interstitials', () => {
    expect(listHtmlUsable('')).toBe(false);
    expect(listHtmlUsable('   ')).toBe(false);
  });

  it('rejects short anti-bot challenge shells', () => {
    expect(listHtmlUsable('<html><title>Verify you are human</title></html>')).toBe(false);
  });
});

describe('isCaptchaPage', () => {
  it('recognizes the common human-verification pages', () => {
    expect(isCaptchaPage('<html><title>Verify you are human</title></html>')).toBe(true);
    expect(isCaptchaPage("<script src='https://challenges.cloudflare.com/turnstile/v0/api.js'></script>")).toBe(true);
    expect(isCaptchaPage('AWS WAF Certification required to continue')).toBe(true);
    expect(isCaptchaPage('route through the captcha challenge before you can continue')).toBe(true);
    expect(isCaptchaPage('There was unusual traffic from your computer network.')).toBe(true);
  });

  it('does not flag real list pages', () => {
    expect(isCaptchaPage('<div class="bookalike review">100 Books Everyone Should Read</div>'.repeat(40))).toBe(false);
    expect(isCaptchaPage('')).toBe(false);
  });

  it('does not flag a large legit page that merely embeds a marker in its JS bundle', () => {
    const bigLegit = '<!doctype html><html><head></head><body>' +
      '<div class="bookalike"><div class="italic">The Road</div></div>'.repeat(6000) +
      '</body></html><script>// this bundle references axios captcha handling</script>';
    expect(bigLegit.length).toBeGreaterThan(64 * 1024);
    expect(isCaptchaPage(bigLegit)).toBe(false);
  });
});