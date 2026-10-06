// SongRoom: vendor diagnostics never emit raw upstream or credential data.
const silent = () => {}
module.exports = { debug: silent, info: silent, warn: silent, error: silent, success: silent, critical: silent }
