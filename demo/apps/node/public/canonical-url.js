/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public URLs never include .html. /admin not /admin.html.
 */
(function canonicalRepublicUrl() {
  var path = location.pathname || "/";
  if (!/\.html$/i.test(path)) return;
  var next = path.replace(/\.html$/i, "") || "/";
  if (next === "/index") next = "/";
  location.replace(next + location.search + location.hash);
})();
