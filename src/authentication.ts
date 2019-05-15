import * as jwt from 'jsonwebtoken'
import {Middleware} from 'koa'
import * as passport from 'koa-passport'
import {ExtractJwt, Strategy as JwtStrategy} from 'passport-jwt'
import {Strategy as LocalStrategy} from 'passport-local'
import {Action} from "routing-controllers"
import {getManager} from 'typeorm'
import {PasswordValidity} from 'unihash'
import PasswordManager from './utils/password'
import User, {IUser} from './models/user'

const db = getManager()
const JWTOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: 'secret',
  issuer: 'cytoid.io',
  audience: 'cytoid.io'
}
passport.use(
  new JwtStrategy(JWTOptions, async (jwt_payload, done) => {
    return done(null, jwt_payload.sub)
  })
)
export function signJWT(payload: any): Promise<string> {
  return new Promise((resolve, reject) => {
    jwt.sign({sub: payload}, JWTOptions.secretOrKey, {
      audience: JWTOptions.audience,
      issuer: JWTOptions.issuer,
      expiresIn: '10d',
    }, (err: Error, encoded: string) => {
      if (err) reject(err)
      else resolve(encoded)
    })
  })
}

passport.use(
  new LocalStrategy(async (username, password, done) => {
    const user = await db.findOne(User, {
      where: [
        {uid: username},
        {email: username},
      ],
    })
    if (!user) { return done(null, false) }
    const passwordVerified = await user.checkPassword(password)
    if (passwordVerified === PasswordValidity.Invalid) { return done(null, false) }
    if (passwordVerified === PasswordValidity.ValidOutdated) {
      const newpassword = await user.setPassword(password)
      await getManager().update(User, {
        where: {id: user.id},
      }, { password: newpassword })
    }
    return done(null, user)
  }),
)

passport.serializeUser((user: User, done) => {
  done(null, user.serialize())
})

passport.deserializeUser((id: IUser, done) => {
  done(null, id)
})

export default passport

export async function currentUserChecker(action: Action): Promise<IUser> {
  return action.context.state.user
}

const authorizationCheckers: Middleware[] = [
  passport.session(),
  passport.authenticate('jwt', {session: false}),
]
export function authorizationChecker(action: Action, roles: string[]) {
  for (const authenticator of authorizationCheckers) {
    authenticator(action.context, () => Promise.resolve())
    if (action.context.state.user)
      break
  }
  return action.context.state.user
}

export function OptionalAuthenticate(context: any, next: (err?: Error) => Promise<any>){
  for (const authenticator of authorizationCheckers) {
    authenticator(context, () => Promise.resolve())
    if (context.state.user)
      break
  }
  context.status = 200
  return next()
}
