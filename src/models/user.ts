import { Exclude, Type } from 'class-transformer'
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn, ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm'
import MailTransport, {ITransport as IMailTransport} from '../utils/mail'

import PasswordManager from '../utils/password'
import File from './file'

export interface IUser {
  id: string
  uid?: string
  name: string
  email?: string
}

@Entity('users')
export default class User implements IUser {
  @PrimaryGeneratedColumn('uuid')
  public id: string

  @Column({ unique: true, nullable: true })
  public uid?: string

  @Column()
  public name: string

  @Column({ unique: true })
  public email: string

  @Type(() => File)
  @ManyToOne(() => File, (file) => file.path)
  public avatar?: File

  @CreateDateColumn({ name: 'date_registration' })
  public registrationDate: Date

  @Exclude()
  @Column('bytea')
  public password: Buffer

  public setPassword(password: string) {
    return PasswordManager.hash(password)
      .then((passwordHash) => {
        this.password = passwordHash
        return passwordHash
      })
  }
  public checkPassword(password: string) {
    return PasswordManager.check(password, this.password)
  }

  public serialize(): IUser {
    return {
      email: this.email,
      id: this.id,
      name: this.name,
      uid: this.uid,
    }
  }

  get mailClient(): IMailTransport | null {
    if (!this.email) {
      return null
    }
    const mailClient = new MailTransport()
    mailClient.recipient = {
      email: this.email,
      name: this.name,
    }
    mailClient.sharedData = {
      name: this.name,
    }
    return mailClient
  }
}

@Entity('emails')
export class Email {
  @PrimaryColumn()
  public address: string

  @Column()
  public verified: boolean

  @Type(() => User)
  @ManyToOne(() => User, (user) => user.id)
  public owner: User

  @Column()
  public ownerId: string
}
