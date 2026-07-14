/**
 * Client-side hooks so relative navigations/forms stay inside /browse
 * instead of hitting the BrowseFreely host (e.g. Google → /search?q=...).
 */
export function buildNavigationGuardScript(baseUrl: string): string {
  // baseUrl is already JS-string-escaped by caller
  return `
(function() {
  var base = '${baseUrl}';

  function isPassthrough(href) {
    if (!href || typeof href !== 'string') return true;
    if (href.charAt(0) === '#') return true;
    if (/^(javascript|mailto|tel|data):/i.test(href)) return true;
    if (href.indexOf('/browse?url=') !== -1) return true;
    if (href.indexOf('/asset?url=') !== -1) return true;
    if (href.indexOf('/api/') === 0) return true;
    if (href === '/' || href.indexOf('/reports') === 0) return true;
    return false;
  }

  function toBrowse(href) {
    try {
      if (isPassthrough(href)) return href;
      var abs = new URL(href, base).href;
      if (abs.indexOf('http') !== 0) return href;
      return '/browse?url=' + encodeURIComponent(abs);
    } catch (e) {
      return href;
    }
  }

  function navigate(href) {
    window.location.href = toBrowse(href);
  }

  try {
    var proto = Location.prototype;
    var rawAssign = proto.assign;
    var rawReplace = proto.replace;
    proto.assign = function(url) { return rawAssign.call(this, toBrowse(String(url))); };
    proto.replace = function(url) { return rawReplace.call(this, toBrowse(String(url))); };
  } catch (e) {}

  try {
    var rawOpen = window.open;
    window.open = function(url, name, specs) {
      if (url) arguments[0] = toBrowse(String(url));
      return rawOpen.apply(this, arguments);
    };
  } catch (e) {}

  // history.pushState / replaceState — keep SPA paths on proxy host mapped
  try {
    var rawPush = history.pushState.bind(history);
    var rawReplaceState = history.replaceState.bind(history);
    history.pushState = function(state, title, url) {
      if (url != null) {
        var proxied = toBrowse(String(url));
        // pushState must be same-origin; use path /browse?... which is same origin
        return rawPush(state, title, proxied);
      }
      return rawPush(state, title, url);
    };
    history.replaceState = function(state, title, url) {
      if (url != null) return rawReplaceState(state, title, toBrowse(String(url)));
      return rawReplaceState(state, title, url);
    };
  } catch (e) {}

  // Form submit: if action already rewritten to /browse?url=..., allow default
  // (server merges q= etc.). Otherwise rebuild full target URL with fields.
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if (form.hasAttribute('data-native-proxy-form')) return;

    var action = form.getAttribute('action') || base;
    if (action.indexOf('/browse?url=') === 0 || action.indexOf('/browse?url=') !== -1) {
      // Already proxied — browser will append fields as sibling query params; server merges.
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    var method = (form.getAttribute('method') || 'get').toLowerCase();
    var abs;
    try {
      abs = new URL(action, base);
    } catch (err) {
      abs = new URL(base);
    }

    if (method === 'get') {
      var fd = new FormData(form);
      fd.forEach(function(value, key) {
        if (typeof value === 'string') abs.searchParams.append(key, value);
      });
      navigate(abs.href);
      return;
    }

    // POST: point at /browse?url=... and let the browser POST field body
    form.setAttribute('action', '/browse?url=' + encodeURIComponent(abs.href));
    form.setAttribute('method', 'post');
    HTMLFormElement.prototype.submit.call(form);
  }, true);

  // Capture clicks on <a> that JS may have mutated after rewrite
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t) return;
    var a = t.closest ? t.closest('a[href]') : null;
    if (!a || a.hasAttribute('data-native-proxy-link')) return;
    var href = a.getAttribute('href');
    if (!href || isPassthrough(href)) return;
    // Absolute http(s) already rewritten should contain /browse?url=
    if (href.indexOf('/browse?url=') !== -1) return;
    // Relative or absolute off-proxy link
    try {
      var abs = new URL(href, base).href;
      if (abs.indexOf('http') === 0) {
        e.preventDefault();
        navigate(abs);
      }
    } catch (err) {}
  }, true);
})();
`
}
