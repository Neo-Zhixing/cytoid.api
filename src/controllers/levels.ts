import {Type} from 'class-transformer'
import {
  ArrayUnique,
  IsBoolean, IsInstance, IsInt, IsNumber,
  Max,
  Min,
  ValidateNested,
} from 'class-validator'
import {Context} from 'koa'
import {
  Authorized,
  BadRequestError,
  Body,
  BodyParam,
  ContentType,
  Ctx,
  CurrentUser,
  ForbiddenError,
  Get, HeaderParam, HttpError, JsonController, NotFoundError,
  Param, Patch, Post, QueryParam, Redirect, Delete,
  UnauthorizedError, UseBefore,
} from 'routing-controllers'
import {getRepository, SelectQueryBuilder} from 'typeorm'

import { Validator } from 'class-validator'
import ac from '../access'
import {OptionalAuthenticate} from '../authentication'
import conf from '../conf'
import {redis} from '../db'
import eventEmitter from '../events'
import {Chart, Level, Rating} from '../models/level'
import Record, {RecordDetails} from '../models/record'
import { IUser } from '../models/user'
import signURL from '../utils/sign_url'
import BaseController from './base'
const validator = new Validator()

class NewRecord {

  @IsInt()
  @Min(0)
  @Max(1000000)
  public score: number

  @IsNumber()
  @Min(0)
  @Max(1)
  public accuracy: number

  @Type(() => RecordDetails)
  @ValidateNested() // FIXME: 500 error "newValue_1.push is not a function" when post an array
  @IsInstance(RecordDetails)
  public details: RecordDetails

  @ArrayUnique() // TODO: check all mods are valid.
  public mods: string[]

  @IsBoolean()
  public ranked: boolean
}

@JsonController('/levels')
export default class LevelController extends BaseController {

  public createPackageConfig = {
    packageLen: 30,
    redisPrefix: 'cytoid:level:create:',
    unpkgURL: conf.functionURL + '/resolve-level-files',
    packagePath: 'levels/packages/',
    bundlePath: 'levels/bundles/',
  }

  private levelRepo = getRepository(Level)
  private chartRepo = getRepository(Chart)

  private levelRatingCacheKey = 'cytoid:level:ratings:'

  @Get('/:id')
  @UseBefore(OptionalAuthenticate)
  public getLevel(
    @Ctx() ctx: Context,
    @Param('id') id: string,
    @CurrentUser() user?: IUser) {
    return this.levelRepo.find({  // Use 'find' instead of 'findOne' to avoid duplicated queries
      where: {uid: id},
      relations: ['bundle', 'charts', 'owner', 'package'],
    })
      .then((levels) => {
        if (levels.length === 0) {
          return undefined
        }
        const level = levels[0]

        level.charts.sort((a, b) => a.difficulty - b.difficulty)

        const result: any = level
        result.packageSize = result.package.size
        delete result.package
        delete result.metadata.raw

        let readAny = false
        if (user) {
          const permission = ac.can(user.role)
          const p = (user.id === level.ownerId) ?
            permission.readOwn('level') :
            permission.readAny('level')
          readAny = p.granted
        }
        if (readAny) {
          ctx.set('Cache-Control', 'private')
          return result // If the user was the owner, return the result without all the checks.
        } else {
          ctx.set('Cache-Control', 'public, max-age=600')
        }

        if (level.censored !== null && level.censored !== 'ccp') {
          throw new HttpError(451, 'censored:' + level.censored)
        } // If the level was censored, return 451. On the global site ignore ccp censorship.

        if (level.published === false) {
          throw new ForbiddenError('Access Denied')
        }
        return result
      })
  }
  @Get('/:id/legacy')
  public getLevelMetaLegacy(@Param('id') id: string) {
    return this.db.createQueryBuilder()
      .select([
        "levels.metadata->'raw' as raw",
        "array_agg(json_build_object('difficulty', c.difficulty, 'type', c.type)) as charts",
      ])
      .from('levels', 'levels')
      .innerJoin('charts', 'c', 'c."levelId"=levels.id')
      .groupBy('levels.metadata')
      .where('levels.uid=:id', { id })
      .getRawOne()
      .then((a) => {
        if (!a) {
          return false
        }
        const diffMap = new Map()
        for (const c of a.charts) {
          diffMap.set(c.type, c.difficulty)
        }
        for (const c of a.raw.charts) {
          c.difficulty = diffMap.get(c.type)
        }
        return a.raw
      })
  }

  @Patch('/:id')
  @Authorized()
  public async editLevel(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
    @Body() level: Level): Promise<null> {
    const existingLevel = await this.levelRepo.findOne({ uid: id }, {
      select: ['ownerId', 'published'] ,
    })
    if (level.tags) {
      level.tags = level.tags.map((a) => a.toLowerCase())
    }

    const permission = existingLevel.ownerId === user.id ?
      ac.can(user.role).updateOwn('level') :
      ac.can(user.role).updateAny('level')

    if (!permission.granted) {
      throw new ForbiddenError("You don't have permission to edit this level")
    }

    level = permission.filter(level)

    await this.levelRepo.update({ uid: id }, level)

    if (existingLevel.published !== true && level.published === true) {
      const detailedLevel = await this.levelRepo.findOne(
        { uid: id },
        {
          relations: ['bundle', 'charts', 'owner'],
        },
      )
      eventEmitter.emit('level_published', detailedLevel)
    }

    return null
  }

  @Delete('/:id')
  @Authorized()
  public async deleteLevel(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<null> {
    const a = await this.levelRepo.delete({ uid: id, ownerId: user.id })
    if (a.affected === 0) {
      throw new NotFoundError()
    }
    return null
  }

  @Get('/')
  @UseBefore(OptionalAuthenticate)
  public async getLevels(
    @CurrentUser() user: IUser,
    @QueryParam('page') pageNum: number = 0,
    @QueryParam('limit') pageLimit: number = 30,
    @QueryParam('order') sortOrder: string = 'asc',
    @Ctx() ctx: Context) {
    const theSortOrder: 'DESC' | 'ASC' = (sortOrder.toUpperCase() === 'DESC') ? 'DESC' : 'ASC'
    if (pageLimit > 200) {
      pageLimit = 200
    } else if (pageLimit < 0) {
      pageLimit = 0
    }
    if (pageNum < 0 || !Number.isInteger(pageNum)) {
      throw new BadRequestError('Page has to be a positive integer!')
    }
    const keyMap: {[index: string]: string} = {
      creation_date: 'levels.date_created',
      modification_date: 'levels.date_modified',
      duration: 'levels.duration',
      downloads: 'downloads',
      plays: 'plays',
      rating: 'aux_rating',
      difficulty: (sortOrder === 'asc' ? 'max' : 'min') + '(charts.difficulty)',
    }
    let query = this.db.createQueryBuilder(Level, 'levels')
      .leftJoin('levels.bundle', 'bundle', "bundle.type='bundle'")
      .leftJoin('levels.owner', 'owner')
      .leftJoin('levels.charts', 'charts')
      .select([
        'levels.title',
        'levels.id',
        'levels.uid',
        'levels.version',
        'levels.metadata',
        'bundle.content',
        'bundle.path',
        'levels.modificationDate',
        'levels.creationDate',
        'json_agg(charts ORDER BY charts.difficulty) as charts',
        '(SELECT (60 + avg(level_ratings.rating) * count(level_ratings.rating)) * 1.0 ' +
        '/ (10 + count(level_ratings.rating)) FROM level_ratings WHERE level_ratings."levelId"=levels.id) as aux_rating',
        '(SELECT avg(level_ratings.rating) FROM level_ratings WHERE level_ratings."levelId"=levels.id) as rating',
        '(SELECT count(*) FROM level_downloads WHERE "levelId"=levels.id) as downloads',
        '(SELECT count(*) FROM records ' +
        'JOIN charts ON charts.id=records."chartId" ' +
        'WHERE charts."levelId"=levels.id) as plays',
      ])
      .groupBy('levels.id, bundle.path, owner.id')
      .limit(pageLimit)
      .offset(pageLimit * pageNum)

    if (ctx.request.query.sort &&
      keyMap[ctx.request.query.sort]
    ) {
      query = query.orderBy(keyMap[ctx.request.query.sort], theSortOrder, 'NULLS LAST')
      if (ctx.request.query.sort !== 'creation_date') {
        query = query.addOrderBy('levels.date_created', 'DESC')
      }

    } else if (!ctx.request.query.search) {
      query = query.orderBy('levels.date_created', theSortOrder)
    }

    {
      let theChartsQb: SelectQueryBuilder<any> = null
      function chartsQb() {
        if (!theChartsQb) {
          theChartsQb = query.subQuery()
            .select('*')
            .from('charts', 'charts')
            .where('charts."levelId"=levels.id')
        }
        return theChartsQb
      }
      // Type filter. There exist a chart with designated type
      if (ctx.request.query.type && ['easy', 'hard', 'extreme'].includes(ctx.request.query.type)) {
        theChartsQb = chartsQb().andWhere('charts.type=:type', { type: ctx.request.query.type })
      }

      // Difficulty filter. There exist a chart satisfying the designated difficulty constraint
      if (ctx.request.query.max_difficulty) {
        theChartsQb = chartsQb().andWhere(
          'charts.difficulty <= :difficulty',
          { difficulty: ctx.request.query.max_difficulty})
      }
      if (ctx.request.query.min_difficulty) {
        theChartsQb = chartsQb().andWhere(
          'charts.difficulty >= :difficulty',
          { difficulty: ctx.request.query.min_difficulty })
      }
      if (theChartsQb) {
        query = query.andWhere(`EXISTS${theChartsQb.getQuery()}`, theChartsQb.getParameters())
      }
    }
    if (ctx.request.query.date_start) {
      query = query.andWhere('levels.date_created >= :date', {date: ctx.request.query.date_start})
    }
    if (ctx.request.query.date_end) {
      query = query.andWhere('levels.date_created <= :date', {date: ctx.request.query.date_end})
    }
    if ('featured' in ctx.request.query) {
      if (ctx.request.query.featured === 'true') {
        query = query.andWhere("'featured'=ANY(levels.category)")
      } else {
        query = query.andWhere("NOT ('featured'=ANY(levels.category))")
      }
    }
    if ('tags' in ctx.request.query) {
      query = query.addSelect('levels.tags')
      if (ctx.request.query.tags) {
        const tags = ctx.request.query.tags
          .split('|')
          .map((a: string) => a.toLowerCase())
        query = query
          .andWhere('levels.tags@>:tags', { tags })
      }
    }
    if (ctx.request.query.search) {
      query = query.innerJoin( (qb) => ({
          getQuery: () => (
            '(SELECT s.id FROM websearch_to_tsquery(:keyword) query, levels_search s ' +
            'WHERE query @@ tsv ORDER BY ts_rank_cd(tsv, query))'
          ),
          getParameters: () => ({ keyword: ctx.request.query.search }),
        }),
        'search',
        'search.id=levels.id',
      )
    }
    if (ctx.request.query.owner) {
      const isUUID = validator.isUUID(ctx.request.query.owner)
      query = query
        .andWhere(`owner.${isUUID ? 'id' : 'uid'}=:id`, { id: ctx.request.query.owner })
    } else {
      query = query.addSelect([
        'owner.uid',
        'owner.email',
        'owner.name',
        'owner.avatarPath',
      ])
    }
    // Exclude the unpublished levels or censored levels unless it's the uploader querying himself
    if (!user ||
      !ctx.request.query.owner ||
      (ctx.request.query.owner !== user.uid && ctx.request.query.owner !== user.id)) {
      // Querying publicly available data
      query = query.andWhere("levels.published=true AND (levels.censored IS NULL OR levels.censored='ccp')")
      ctx.set('Cache-Control', 'public, max-age=60')
    } else {
      // Querying user-specific data
      ctx.set('Cache-Control', 'private')
      query = query.addSelect('levels.published')
    }
    const count = await query.getCount()
    ctx.set('X-Total-Entries', count.toString())
    if (pageLimit === 0) {
      return null
    }
    ctx.set('X-Total-Page', Math.ceil(count / pageLimit).toString())
    ctx.set('X-Current-Page', pageNum.toString())
    return query.getRawAndEntities()
      .then(({entities, raw}) => {
        return entities.map((level: any, index) => {
          const rawRecord = raw[index]
          level.charts = rawRecord.charts
          level.rating = parseFloat(rawRecord.rating) || null
          level.plays = parseInt(rawRecord.plays, 10) // Optional
          level.downloads = parseInt(rawRecord.downloads, 10) // Optional
          return level
        })
      })
  }

  /**
   * Get the rating distribution, total count, and mean ratings for a level.
   * If the user was authenticated, also returns the rating the user gave.
   * @param id The UID of the level
   * @param user The user. Optional.
   */
  @Get('/:id/ratings')
  @UseBefore(OptionalAuthenticate)
  @ContentType('application/json')
  public async getRatings(@Param('id') id: string, @CurrentUser() user?: IUser) {
    const cacheVal = await redis.getAsync(this.levelRatingCacheKey + id)
    if (cacheVal) {
      if (user) {
        const rating = await this.db.createQueryBuilder()
          .select('rating')
          .from('level_ratings', 'ratings')
          .where('"userId" = :userId', {userId: user.id})
          .andWhere('"levelId" = (SELECT id FROM levels WHERE uid = :levelId)', {levelId: id})
          .getRawOne()
          .then((a) => {
            return a ? a.rating : null
          })
        const result = JSON.parse(cacheVal)
        result.rating = rating
        return result
      } else {
        return cacheVal
      }
    }
    // language=PostgreSQL
    return this.db.query(
`
WITH ratings AS (SELECT rating, "userId"
                 FROM level_ratings
                 WHERE "levelId" = (SELECT id FROM levels WHERE uid = $1))
SELECT avg(rating) AS average,
       count(*)           AS total,
       ${user ? '(SELECT rating from ratings where "userId" = $2),' : ''}
       array(SELECT coalesce(data.count, 0) AS rating
             FROM (SELECT generate_series(1, 10) items) fullrange
             LEFT OUTER JOIN (SELECT ratings.rating, count(ratings.rating)
                              FROM ratings
                              GROUP BY ratings.rating) data ON data.rating = fullrange.items) AS distribution
FROM ratings`,
      user ? [id, user.id] : [id])
      .then(async (a) => {
        a = a[0]
        a.average = parseFloat(a.average)
        a.total = parseInt(a.total, 10)
        a.distribution = a.distribution.map((i: string) => parseInt(i, 10))
        const rating = parseInt(a.rating, 10)
        delete a.rating
        await redis.setexAsync(this.levelRatingCacheKey + id, 3600, JSON.stringify(a))
        if (rating) { a.rating = rating }
        return a
      })
  }

  /**
   * Update the ratings for a level. Authentication Required.
   * @param id
   * @param user
   * @param rating
   */
  @Post('/:id/ratings')
  @Authorized()
  public async updateRatings(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
    @BodyParam('rating', {required: true}) rating: number) {
    const qb = this.db.createQueryBuilder()
    const levelIdQuery = qb.subQuery()
      .createQueryBuilder()
      .select('id')
      .from(Level, 'level')
      .where('level.uid = :uid', {uid: id})
    if (!rating) {
      // Remove the rating
      const results = await qb.delete()
        .from(Rating)
        .where(`"levelId"=(${levelIdQuery.getQuery()})`)
        .andWhere('userId=:userId', { userId: user.id })
        .setParameters(levelIdQuery.getParameters())
        .execute()
      if (results.affected === 0) {
        throw new NotFoundError('The specified level does not exist!')
      }
    } else {
      if (rating > 10 || rating <= 0) {
        throw new BadRequestError('Rating missing or out of range (0 - 10)')
      }
      await qb
        .insert()
        .into(Rating)
        .values({
          levelId: () => `(${levelIdQuery.getQuery()})`,
          userId: user.id,
          rating,
        })
        .onConflict('ON CONSTRAINT "level_ratings_levelId_userId_key" DO UPDATE SET "rating" = :rating')
        .setParameter('rating', rating)
        .setParameters(levelIdQuery.getParameters())
        .execute()
        .catch((error) => {
          if (error.column === 'levelId'
            && error.table === 'level_ratings'
            && error.code === '23502') {
            throw new NotFoundError('The specified level does not exist!')
          }
          throw error
        })
    }

    await redis.delAsync(this.levelRatingCacheKey + id)
    return this.getRatings(id, user)
  }

  @Get('/:id/statistics/timeseries')
  public getStatistics(@Param('id') id: number) {
    if (!id) {
      throw new BadRequestError()
    }
    return this.db.query(`\
      SELECT count(*)::integer, extract(week from records.date) as week, extract(year from date) as year
      FROM records
      WHERE "chartId" IN (SELECT id FROM charts WHERE "levelId" = $1)
      GROUP BY year, week
      ORDER BY year, week`, [id])
  }

  @Get('/:id/charts/:chartType/')
  public getChart(@Param('id') id: string, @Param('chartType') chartType: string) {
    return this.db.createQueryBuilder()
      .select('name')
      .addSelect('difficulty')
      .from(Chart, 'chart')
      .where('type = :chartType', {chartType})
      .andWhere('"levelId" = (SELECT id FROM levels WHERE uid = :levelId)', {levelId: id})
      .getRawOne()
      .then((a) => {
        if (!a) {
          return null
        }
        a.level = id
        a.type = chartType
        return a
      })
  }

  @Get('/:id/charts/:chartType/checksum')
  public getLevelChecksum(
    @HeaderParam('authorization') token: string,
    @Param('id') id: string,
    @Param('chartType') chartType: string,
  ) {
    if (token !== '6gH2cFOhN&R2qZGoHP6@I*zhlGntjrN1k4aZ3XS#TUj7K^cG$v') {
      throw new UnauthorizedError()
    }
    return this.db.createQueryBuilder()
      .select('checksum')
      .from(Chart, 'chart')
      .where('type = :chartType', {chartType})
      .andWhere('"levelId" = (SELECT id FROM levels WHERE uid = :levelId)', {levelId: id})
      .getRawOne()
      .then((a) => a && a.checksum)
  }

  @Get('/:id/charts/:chartType/ranking')
  public async getChartRanking(
    @Ctx() ctx: Context,
    @Param('id') id: string,
    @Param('chartType') chartType: string,
    @QueryParam('limit') limit: number = 10,
    @QueryParam('page') page: number = 0,
    @QueryParam('user') user?: string,
    @QueryParam('userLimit') userLimit: number = 3) {
    if (userLimit < 0) {
      userLimit = 0
    }
    if (userLimit > 10) {
      userLimit = 10
    }
    let qb = this.queryLeaderboard(id, chartType)
    if (user) {
      const isUUID = validator.isUUID(user, '4')
      const rankQuery = `SELECT rank FROM lb WHERE u_id=${isUUID ? ':user' : '(SELECT id FROM users WHERE uid=:user)'}`
      // Hack the original getQuery to insert the WITH clause
      // This is all because TypeORM does not support .with clause
      // See https://github.com/typeorm/typeorm/issues/1116
      const orgQuery = qb.getQuery
      const orgParams = qb.getParameters
      qb.getQuery = () => `WITH lb AS (${orgQuery.call(qb)}) SELECT * FROM lb WHERE abs(rank - (${rankQuery})) <= :userLimit`
      qb.getParameters = () => {
        const a = orgParams.call(qb)
        a.user = user
        a.userLimit = userLimit
        return a
      }
    } else {
      if (limit > 30) {
        limit = 30
      }
      qb = qb
        .limit(limit)
        .offset(limit * page)

      const count = await this.db.createQueryBuilder(Record, 'r')
        .select('count(DISTINCT r."ownerId")')
        .where(
          '"chartId"=' +
          '(SELECT id FROM charts WHERE "levelId"=(SELECT id FROM levels WHERE uid=:uid) AND type=:type)',
          { uid: id, type: chartType },
        )
        .andWhere('ranked=true')
        .getRawOne()
        .then((a) => a.count)
      ctx.set('X-Total-Page', Math.floor(count / limit).toString())
      ctx.set('X-Total-Entries', count.toString())
      ctx.set('X-Current-Page', page.toString())
    }
    const { entities, raw } = await qb.getRawAndEntities()
    entities.forEach((record, index) => {
      (record as any).rank = raw[index].rank
    })
    if (entities.length === 0) {
      // length is 0, check the existence of the level
      const count = await this.db.createQueryBuilder(Chart, 'c')
        .where('c.type=:type', { type: chartType })
        .andWhere('c."levelId"=(SELECT id FROM levels WHERE uid=:uid)', { uid: id })
        .getCount()
      if (count === 0) {
        throw new NotFoundError()
      }
    }
    return entities
  }

  @Post('/:id/charts/:chartType/records')
  @Authorized()
  public addRecord(
    @Param('id') id: string,
    @Param('chartType') chartType: string,
    @CurrentUser() user: IUser,
    @Body() record: NewRecord) {
    const qb = this.db.createQueryBuilder()
    const chartQuery =
    qb.subQuery()
      .select('id')
      .from(Chart, 'chart')
      .where('type = :chartType', {chartType})
      .andWhere('"levelId" = (SELECT id FROM levels WHERE uid = :levelId)', {levelId: id})
    return  qb.insert()
      .into(Record)
      .values({
        ownerId: user.id,
        chart: () => chartQuery.getQuery(),
        ...record,
      })
      .setParameters(chartQuery.getParameters())
      .returning('"chartId", id')
      .execute()
      .catch((error) => {
        if (error.table === 'records' && error.column === 'chartId' && error.code === '23502') {
          throw new NotFoundError('The specified chart was not found.')
        }
        throw error
      })
  }

  @Get('/:id/resources')
  @Authorized()
  public getResourcesURL(@Param('id') levelId: string, @CurrentUser() user: IUser) {
    return this.db.createQueryBuilder(Level, 'l')
      .select('l.packagePath')
      .where({ uid: levelId })
      .getOne()
      .then((a) => {
        const path = a.packagePath
        this.db.query(`\
INSERT INTO level_downloads ("levelId", "userId") VALUES ((SELECT id FROM levels WHERE uid=$1), $2)
ON CONFLICT ("levelId", "userId")
DO UPDATE SET "date"=NOW(), "count"=level_downloads."count"+1;`, [levelId, user.id])
        const signedURL =  signURL(conf.assetsURL, path, 3600)
        return {
          package: signedURL,
        }
      })
  }

  @Get('/:id/package')
  @Redirect(':assetsURL/:path')
  @Authorized()
  public downloadPackage(@Param('id') levelId: string, @CurrentUser() user: IUser) {
    return this.db.createQueryBuilder(Level, 'l')
      .select('l.packagePath')
      .where({ uid: levelId })
      .getOne()
      .then((a) => {
        const path = a.packagePath
        this.db.query(`\
INSERT INTO level_downloads ("levelId", "userId") VALUES ((SELECT id FROM levels WHERE uid=$1), $2)
ON CONFLICT ("levelId", "userId")
DO UPDATE SET "date"=NOW(), "count"=level_downloads."count"+1;`, [levelId, user.id])
        return signURL(conf.assetsURL, path, 3600)
      })
  }

  private queryLeaderboard(levelUid: string, chartType: string) {
    const mainQuery: SelectQueryBuilder<Record> = this.db
    .createQueryBuilder()
    .select([
      'u.name',
      'u.uid',
      'u.email',
      'u.avatarPath',
      'u.id',
      'r.id',
      'r.date',
      'r.score',
      'r.accuracy',
      'r.details',
      'r.mods',
      '(rank() OVER (ORDER BY score DESC, date ASC))::integer',
    ])
      .from((qb: SelectQueryBuilder<Record>) => qb
        .select('DISTINCT ON ("ownerId") *')
        .from(Record, 'record')
        .where(
          '"chartId"=' +
          '(SELECT id FROM charts WHERE "levelId"=(SELECT id FROM levels WHERE uid=:uid) AND type=:type)',
          { uid: levelUid, type: chartType },
        )
        .andWhere('ranked=true')
        .orderBy('"ownerId"')
        .addOrderBy('score', 'DESC')
        .addOrderBy('date', 'ASC'), 'r')

    // Adding metadata for our 'from' subquery
    // The metadata of the subquery is undetermined so we have to add it manually
    const subqueryAlias = mainQuery.expressionMap.findAliasByName('r')
    subqueryAlias.metadata = mainQuery.connection.getMetadata(Record)

    return mainQuery.leftJoin('r.owner', 'u')
  }
}
