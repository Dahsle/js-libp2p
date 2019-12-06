'use strict'

const net = require('net')
const EventEmitter = require('events')
const log = require('debug')('libp2p:tcp:listener')
const toConnection = require('./socket-to-conn')
const { CODE_P2P } = require('./constants')
const {
  getMultiaddrs,
  multiaddrToNetConfig
} = require('./utils')

module.exports = ({ handler, upgrader }, options) => {
  const listener = new EventEmitter()

  const server = net.createServer(async socket => {
    // Avoid uncaught errors caused by unstable connections
    socket.on('error', err => log('socket error', err))

    const maConn = toConnection(socket, { listeningAddr })
    log('new inbound connection %s', maConn.remoteAddr)

    const conn = await upgrader.upgradeInbound(maConn)
    log('inbound connection %s upgraded', maConn.remoteAddr)

    trackConn(server, maConn)

    if (handler) handler(conn)
    listener.emit('connection', conn)
  })

  server
    .on('listening', () => listener.emit('listening'))
    .on('error', err => listener.emit('error', err))
    .on('close', () => listener.emit('close'))

  // Keep track of open connections to destroy in case of timeout
  server.__connections = []

  listener.close = () => {
    if (!server.listening) return

    return new Promise((resolve, reject) => {
      server.__connections.forEach(maConn => maConn.close())
      server.close(err => err ? reject(err) : resolve())
    })
  }

  let peerId, listeningAddr

  listener.listen = ma => {
    listeningAddr = ma
    peerId = ma.getPeerId()

    if (peerId) {
      listeningAddr = ma.decapsulateCode(CODE_P2P)
    }

    return new Promise((resolve, reject) => {
      const options = multiaddrToNetConfig(listeningAddr)
      server.listen(options, err => {
        if (err) return reject(err)
        log('Listening on %s', server.address())
        resolve()
      })
    })
  }

  listener.getAddrs = () => {
    let addrs = []
    const address = server.address()

    if (!address) {
      throw new Error('Listener is not ready yet')
    }

    // Because TCP will only return the IPv6 version
    // we need to capture from the passed multiaddr
    if (listeningAddr.toString().startsWith('/ip4')) {
      addrs = addrs.concat(getMultiaddrs('ip4', address.address, address.port))
    } else if (address.family === 'IPv6') {
      addrs = addrs.concat(getMultiaddrs('ip6', address.address, address.port))
    }

    return addrs.map(ma => peerId ? ma.encapsulate(`/p2p/${peerId}`) : ma)
  }

  return listener
}

function trackConn (server, maConn) {
  server.__connections.push(maConn)

  const untrackConn = () => {
    server.__connections = server.__connections.filter(c => c !== maConn)
  }

  maConn.conn.once('close', untrackConn)
}
