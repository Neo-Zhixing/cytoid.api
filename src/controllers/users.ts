import { plainToClass } from 'class-transformer'
import {
  IsEmail, IsOptional, IsString,
  MinLength, Validator,
} from 'class-validator'
import {Context} from 'koa'
import {
  Authorized, BadRequestError, Body, BodyParam, Ctx,
  CurrentUser, Delete,
  ForbiddenError,
  Get, HeaderParam, HttpCode,
  JsonController, NotFoundError, OnUndefined, Param,
  Patch, Post,
  Put, QueryParam, Redirect, UnauthorizedError, UseBefore,
} from 'routing-controllers'
import {getRepository} from 'typeorm'
import {getExternalProviderSession, signJWT} from '../authentication'
import config from '../conf'
import eventEmitter from '../events'
import CaptchaMiddleware from '../middlewares/captcha'
import Email from '../models/email'
import Profile from '../models/profile'
import User, {ExternalAccount, IUser} from '../models/user'
import MailClient from '../utils/mail'
import {VerificationCodeManager} from '../utils/verification_code'
import BaseController from './base'
const CodeVerifier = new VerificationCodeManager('email_verification')

const validator = new Validator()

class NewUserDto {
  @IsString()
  @IsOptional()
  public name?: string

  @IsString()
  @IsOptional()
  public uid?: string

  @MinLength(8)
  public password: string

  @IsEmail()
  @IsOptional()
  public email?: string
}

@JsonController('/users')
export default class UserController extends BaseController {
  private repo = getRepository(User)

  @Get('/')
  @Authorized()
  public getCurrentUser(@CurrentUser() user: IUser) {
    return this.repo.findOne(user.id)
  }

  @Get('/:id')
  public getUser(@Param('id') id: string): Promise<User|string> {
    return this.repo.findOne({
      where: validator.isUUID(id, '4') ? { id } : { uid: id },
    })
  }

  @Get('/:id/avatar')
  @Redirect('https://google.com') // TO
  public getAvatar(
    @Param('id') id: string,
    @QueryParam('size') size: number = 512,
  ) {
    return this.db.createQueryBuilder(User, 'u')
      .select(['u.id', 'u.uid', 'u.email', 'u.avatarPath'])
      .where(validator.isUUID(id, '4') ? { id } : { uid: id })
      .getOne()
      .then((user) => {
        if (!user) {
          throw new NotFoundError()
        }
        return user.getAvatarURL(size)
      })
  }

  @Delete('/:id/avatar')
  @Authorized()
  public async deleteAvatar(@Param('id') id: string, @CurrentUser() user: IUser): Promise<null> {
    const isUUID = validator.isUUID(id, '4')
    if (isUUID ? (id !== user.id) : (id !== user.uid)) {
      throw new UnauthorizedError()
    }
    await this.repo.update(
      validator.isUUID(id, '4') ? { id } : { uid: id },
      { avatarPath: null },
    )
    return null
  }

  @Put('/:id')
  @Authorized()
  @OnUndefined(202)
  public async editUser(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
    @BodyParam('name') newUsername: string,
    @Ctx() ctx: Context,
  ) {
    if (user.id !== id) {
      throw new UnauthorizedError()
    }
    await this.db.createQueryBuilder()
      .update(User)
      .set({ name: newUsername })
      .where('id=:id', { id })
      .execute()

    const entity = plainToClass(User, user)
    entity.name = newUsername
    await ctx.logIn(entity)
  }

  @Post('/')
  @UseBefore(CaptchaMiddleware('signup'))
  public createUser(@Body() newUser: NewUserDto, @Ctx() ctx: Context) {
    if (newUser.email) {
      newUser.email = newUser.email.toLowerCase()
    }
    if (newUser.uid) {
      newUser.uid = newUser.uid.toLowerCase()
    }
    return this.db.transaction(async (transaction) => {
      let user = new User()
      user.name = newUser.name
      user.uid = newUser.uid
      await user.setPassword(newUser.password)

      user = await transaction.save(user)
      if (newUser.email) {
        await transaction.insert(Email, {
          address: newUser.email,
          ownerId: user.id,
        })
        await transaction.update(User, {id: user.id }, { email: newUser.email })
        user.email = newUser.email
      }
      await transaction.insert(Profile, {
        id: user.id,
      })
      return user
    })
      .catch((error) => {
        if (error.constraint === 'emails_pkey') {
          throw new ForbiddenError('The email address already exist')
        } else if (error.constraint === 'users_uid_key') {
          throw new ForbiddenError('The UID already exist')
        }
        throw error
      })
      .then(async (user) => {
        eventEmitter.emit('user_new', user)
        await ctx.login(user)
        return {
          user,
          token: await signJWT(user.serialize()),
        }
      })
  }

  @Put('/')
  public async createUserWithExternalSession(
    @Body() newUser: NewUserDto,
    @BodyParam('token') token: string,
    @BodyParam('provider') provider: string,
    @Ctx() ctx: Context,
  ) {
    const sessionData = await getExternalProviderSession(token, provider)
    if (!sessionData) {
      throw new NotFoundError('session does not exist')
    }
    newUser.email = sessionData.email || newUser.email
    // TODO: import avatar...
    const result = await this.createUser(newUser, ctx)
    await this.db
      .createQueryBuilder()
      .insert()
      .into(ExternalAccount)
      .values({
        provider,
        uid: sessionData.id,
        token: sessionData.token,
        ownerId: result.user.id,
      })
      .onConflict('("provider", "ownerId") DO UPDATE SET uid=excluded.uid, token=excluded.token')
      .execute()
    return result
  }

  @Get('/:id/emails')
  @Authorized()
  public getUserEmails(@Param('id') id: string, @CurrentUser() user: IUser) {
    if (user.id !== id) {
      throw new UnauthorizedError()
    }
    return this.db.createQueryBuilder(Email, 'emails')
      .select(['emails.address as address', 'emails.verified as verified', '(emails.address=owner.email) as primary'])
      .where('owner.id=:id', { id })
      .innerJoin('users', 'owner', 'owner.id=emails."ownerId"')
      .getRawMany()
  }

  @Post('/:id/emails')
  @HttpCode(201)
  @Authorized()
  public addUserEmail(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
    @BodyParam('email', {required: true}) email: string,
  ) {
    email = email.toLowerCase()
    if (!validator.isEmail(email)) {
      throw new BadRequestError('email not valid')
    }
    if (user.id !== id) {
      throw new UnauthorizedError()
    }
    return this.db.createQueryBuilder(Email, 'emails')
      .insert()
      .values({
        address: email,
        verified: false,
        ownerId: user.id,
      })
      .execute()
      .catch((error) => {
        if (error.constraint === 'emails_pkey') {
          throw new BadRequestError('duplicated email address')
        }
        throw error
      })
      .then(() => this.getUserEmails(id, user))
  }

  @Patch('/:id/emails/:email')
  @Authorized()
  @HttpCode(204)
  public setPrimaryEmail(
    @Param('id') id: string,
    @Param('email') email: string,
    @BodyParam('primary') primary: boolean,
    @CurrentUser() user: IUser) {
    if (user.id !== id) {
      throw new UnauthorizedError()
    }
    email = email.toLowerCase()
    if (primary) {
      return this.db.query(
        'UPDATE users SET email=$1 WHERE id=$2 AND id=(SELECT id FROM emails WHERE address=$1)',
        [email, id])
        .catch((error) => {
          if (error.constraint === 'users_email_pkey') {
            throw new NotFoundError('email not found')
          }
          throw error
        })
    } else {
      return this.db.query('UPDATE users SET email=NULL WHERE id=$1', [id])
    }
  }

  @Delete('/:id/emails/:email')
  @Authorized()
  @HttpCode(204)
  public deleteEmail(@CurrentUser() user: IUser, @Param('id') userId: string, @Param('email') email: string) {
    if (userId !== user.id) {
      throw new UnauthorizedError()
    }
    email = email.toLowerCase()
    return this.db.createQueryBuilder()
      .delete()
      .from('emails')
      .where('address=:email AND "ownerId"=:userId', { email, userId })
      .execute()
      .then((result) => (result.affected === 0) ? Promise.reject(new NotFoundError()) : Promise.resolve(true))
  }

  @Post('/:id/emails/:email/verify')
  @Authorized()
  @HttpCode(202)
  public verifyEmail(@CurrentUser() user: IUser, @Param('id') userId: string, @Param('email') email: string) {
    if (userId !== user.id) {
      throw new UnauthorizedError()
    }
    email = email.toLowerCase()
    return this.db.createQueryBuilder()
      .select('verified', 'verified')
      .from('emails', 'e')
      .where('e.address=:email AND e."ownerId"=:userId', { email, userId })
      .getRawOne()
      .then((item) => {
        if (!item) {
          throw new NotFoundError()
        }
        if (item.verified) {
          throw new ForbiddenError('already verified')
        }
        return CodeVerifier.generate(email)
      })
      .then((token) => {
        MailClient.sendWithRemoteTemplate('email-confirm',
          { name: user.name || user.uid, email },
          { url: config.apiURL + `/users/${userId}/emails/${email}/verify/${token}`})
        return null
      })
  }

  @Get('/:id/emails/:email/verify/:token')
  public async confirmEmail(@Param('id') userId: string, @Param('email') email: string, @Param('token') token: string) {
    email = email.toLowerCase()
    if (await CodeVerifier.makeInvalidate(token) !== email) {
      return 'The token was expired.'
    }
    await this.db.query(
      'UPDATE emails SET verified=true WHERE verified=false AND address=$1 AND "ownerId"=$2',
      [email, userId])

    return 'Your email was successfully confirmed!'
  }

  @Authorized()
  @Post('/:id/providers/:provider')
  public async addProvider(
    @CurrentUser() user: IUser,
    @Param('id') id: string,
    @Param('provider') provider: string,
    @BodyParam('token') token: string,
  ): Promise<null> {
    if (user.id !== id) {
      throw new ForbiddenError()
    }
    const sessionData = await getExternalProviderSession(token, provider)
    if (!sessionData) {
      throw new NotFoundError('session does not exist')
    }
    await this.db
      .createQueryBuilder()
      .insert()
      .into(ExternalAccount)
      .values({
        provider,
        uid: sessionData.id,
        token: sessionData.token,
        ownerId: id,
      })
      .onConflict('("provider", "ownerId") DO UPDATE SET uid=excluded.uid, token=excluded.token')
      .execute()
    return null
  }

  @Authorized()
  @Delete('/:id/providers/:provider')
  public async removeProvider(
    @CurrentUser() user: IUser,
    @Param('id') id: string,
    @Param('provider') provider: string,
  ): Promise<null> {
    if (user.id !== id) {
      throw new ForbiddenError()
    }
    await this.db
      .createQueryBuilder()
      .delete()
      .from(ExternalAccount)
      .where({ provider, ownerId: id })
      .execute()
    return null
  }

  @Authorized()
  @Get('/:id/providers')
  public getProviderStatus(@CurrentUser() user: IUser, @Param('id') id: string) {
    if (user.id !== id) {
      throw new ForbiddenError()
    }
    return this.db.createQueryBuilder(ExternalAccount, 'e')
      .select(['e.provider'])
      .where({ ownerId: id })
      .getMany()
      .then((results) => results.map((r) => r.provider))
  }
}
