/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Public URLs never include .html. /admin not /admin.html.
 */
(function canonicalZkVotingUrl() {
  var path = location.pathname || "/";
  if (!/\.html$/i.test(path)) return;
  var next = path.replace(/\.html$/i, "") || "/";
  if (next === "/index") next = "/";
  location.replace(next + location.search + location.hash);
})();
