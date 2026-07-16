function requireSession(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  return res.redirect('/login');
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: x-api-key invalid atau tidak ada.' });
  }
  return next();
}

module.exports = { requireSession, requireApiKey };
