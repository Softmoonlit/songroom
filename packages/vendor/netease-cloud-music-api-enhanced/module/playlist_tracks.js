// SongRoom: one business step sends at most one write, including code 512.
const createOption = require('../util/option.js')
module.exports = async (query, request) => {
  const tracks = query.tracks.split(',')
  return request(
    '/api/playlist/manipulate/tracks',
    { op: query.op, pid: query.pid, trackIds: JSON.stringify(tracks), imme: 'true' },
    createOption(query),
  )
}
