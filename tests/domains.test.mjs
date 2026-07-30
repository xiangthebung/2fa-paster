/**
 * Domain arithmetic, which decides whose code you are looking at.
 *
 * Nothing here throws when it is wrong — it just quietly answers "different
 * company" about a message from the site you are signing in to, and the extension
 * sets aside the one code you wanted. So the awkward shapes are pinned down:
 * multi-label suffixes, mail subdomains, and `From` headers in each of the forms
 * the two readers produce.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  domainLabel,
  isGenericLabel,
  isRelayDomain,
  registrableDomain,
  relatedLabels,
  senderAddress,
  senderDomain,
  senderName,
  siteOf,
} from '../domains.js';

test('a hostname reduces to the domain someone could have registered', () => {
  assert.equal(registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(registrableDomain('github.com'), 'github.com');
  assert.equal(registrableDomain('www.github.com'), 'github.com');
  assert.equal(registrableDomain('GitHub.COM'), 'github.com');
  assert.equal(registrableDomain('notion.so'), 'notion.so');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain(''), '');
  assert.equal(registrableDomain(undefined), '');
});

test('suffixes that are two labels long do not swallow the name', () => {
  // The failure this guards against: "co.uk" as the registrable domain, which
  // makes every British site look like the same company.
  assert.equal(registrableDomain('secure.hsbc.co.uk'), 'hsbc.co.uk');
  assert.equal(registrableDomain('id.rakuten.co.jp'), 'rakuten.co.jp');
  assert.equal(registrableDomain('login.mysite.com.au'), 'mysite.com.au');
});

test('a page URL reduces to a site, and anything unaddressable to nothing', () => {
  assert.equal(siteOf('https://accounts.google.com/signin/v2/challenge'), 'google.com');
  assert.equal(siteOf('http://localhost:3000/login'), 'localhost');
  assert.equal(siteOf('chrome://extensions'), '');
  assert.equal(siteOf('about:blank'), '');
  assert.equal(siteOf('not a url'), '');
  assert.equal(siteOf(''), '');
});

test('a From header yields an address, a domain and something to show', () => {
  for (const header of ['GitHub <noreply@github.com>', '"GitHub" <noreply@github.com>']) {
    assert.equal(senderAddress(header), 'noreply@github.com');
    assert.equal(senderDomain(header), 'github.com');
    assert.equal(senderName(header), 'GitHub');
  }

  // The inbox feed can give a name with no address, or an address with no name.
  assert.equal(senderDomain('GitHub'), '');
  assert.equal(senderName('GitHub'), 'GitHub');
  assert.equal(senderAddress('noreply@github.com'), 'noreply@github.com');
  // A bare address shows as its domain: "noreply" is nobody.
  assert.equal(senderName('noreply@github.com'), 'github.com');
  assert.equal(senderName(''), 'your inbox');

  assert.equal(senderDomain('Security <security@email.notifications.github.com>'), 'github.com');
});

test('labels are compared loosely enough for a dedicated mail domain', () => {
  assert.equal(domainLabel('github.com'), 'github');
  assert.equal(domainLabel('hsbc.co.uk'), 'hsbc');

  assert.equal(relatedLabels('github', 'github'), true);
  assert.equal(relatedLabels('githubmail', 'github'), true);
  assert.equal(relatedLabels('github', 'acme'), false);
  // Short labels are not compared by containment: too many coincidences.
  assert.equal(relatedLabels('app', 'apple'), false);
  assert.equal(relatedLabels('', 'github'), false);
});

test('relays and channel-named domains are recognised as naming nobody', () => {
  assert.equal(isRelayDomain('sendgrid.net'), true);
  assert.equal(isRelayDomain('amazonses.com'), true);
  assert.equal(isRelayDomain('github.com'), false);

  assert.equal(isGenericLabel('accounts'), true);
  assert.equal(isGenericLabel('accountprotection'), true);
  assert.equal(isGenericLabel('github'), false);
});
