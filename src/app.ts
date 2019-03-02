import 'reflect-metadata' // this shim is required
import { createExpressServer } from 'routing-controllers'

import * as controllers from './controllers'
import logger from './logger'
import conf from './conf'
import { redis } from './db'

const app = createExpressServer({
  controllers: Object.values(controllers),
})

app.set('trust proxy', 1)

import session = require('express-session')
import connectRedis = require('connect-redis')
const RedisStore = connectRedis(session)
app.use(session({
  store: new RedisStore({
    client: redis
  }),
  secret: conf.secret,
  /*
   Forces the session to be saved back to the session store,
   even if the session was never modified during the request.
   Check with your store if it implements the touch method.
   If it does, then you can safely set resave: false.
   */
  resave: false,
  /*
   Forces a session that is "uninitialized" to be saved to the store.
   */
  saveUninitialized: false,
  cookie: {
    secure: true,
  },
  /*
   Control the result of unsetting req.session
   */
  unset: 'destroy',
}))

import morgan = require('morgan')

// @ts-ignore
app.use(morgan('combined', {
  stream: {
    write (message: string, encoding: any) {
      logger.debug(message)
    }
  }
}))

export default app