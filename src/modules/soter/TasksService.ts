import {HttpService, Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {SoterService} from './soter.service';
import {ArchiveService} from './archive.service';
import * as fs from 'fs';
import {SyncTime} from '../../model/syncTime.entity';
import {ConfigService} from '../../config/config.service';
import {MapService} from './map.service';
import AdmZip = require('adm-zip');
import {CidStorageService} from '../contracts/cidStorage.service';
import {getConnection} from 'typeorm';
import {TelegramService} from 'nestjs-telegram';

@Injectable()
export class TasksService {
    private readonly logger = new Logger(TasksService.name);

    constructor(
        private readonly soterService: SoterService,
        private readonly archiveService: ArchiveService,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
        private readonly mapService: MapService,
        private readonly cidStorageService: CidStorageService,
        private readonly telegram: TelegramService,
    ) {
    }

    @Cron('* * * * *', {
        name: 'sync',
    })
    async handleCronSync() {
        const syncTimes = await SyncTime.findAllNotSynced();
        await this.mapService.create();
        try {
            for (const syncTime of syncTimes) {
                this.logger.debug('===================== SYNC =====================');
                const admZip = new AdmZip();
                const zipPath = `./files/${syncTime.hash}.zip`;
                const dirPath = this.archiveService.generateDirPath(syncTime.hash);
                const entityMap = Object.assign(
                    syncTime.entityMapFiles,
                    syncTime.entityMapSubscribes,
                    syncTime.entityMapLikes,
                    syncTime.entityMapPosts,
                    syncTime.entityMapUsers,
                    syncTime.entityMapUnLikes,
                    syncTime.entityMapUnSubscribes,
                    syncTime.entityMapComments,
                );

                if (Object.keys(syncTime.fileMap).length === 0) {
                    await syncTime.remove();
                    continue;
                }

                if (fs.existsSync(dirPath)) {
                    admZip.addLocalFolder(dirPath, '');
                }
                admZip.addFile('map.json', Buffer.from(JSON.stringify(syncTime.fileMap)));
                admZip.addFile('entities.json', Buffer.from(JSON.stringify(entityMap)));
                admZip.writeZip(zipPath);
                if (!fs.existsSync(zipPath)) {
                    continue;
                }
                const file = fs.readFileSync(zipPath);
                this.logger.debug('Sync started!');
                await this.telegram.sendMessage({
                    chat_id: '-330731984',
                    text: 'Sync started!'
                }).toPromise();
                const soterResult = await this.soterService.add(file, syncTime.hash + '.zip');
                if (!soterResult.data.cid || soterResult.data.cid === '') {
                    await this.telegram.sendMessage({
                        chat_id: '-330731984',
                        text: 'Error: Cid empty in btfs response!'
                    }).toPromise();
                    throw new Error('Cid empty!');
                }

                const responseIgniteNode = await this.httpService.post(this.configService.getIgniteNodeAddress() + '/api/v3/btfs', {
                    btfsCid: soterResult.data.cid,
                    peerWallet: this.configService.get('PEER_WALLET'),
                    peerIp: this.configService.get('PEER_IP'),
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }).toPromise();

                this.logger.debug('Zip file to Btfs saved!');
                syncTime.synced = true;
                syncTime.btfsCid = soterResult.data.cid;
                await syncTime.save();
                const tx = await this.cidStorageService.setCid(soterResult.data.cid);
                this.logger.debug(tx);

                this.logger.debug('Soter data: ' + JSON.stringify(soterResult.data));
                this.logger.debug('Ignite node response status: ' + String(responseIgniteNode.status));
                this.logger.debug('Sync completed!');

                await this.telegram.sendMessage({
                    chat_id: '-330731984',
                    text: 'Sync completed! Soter CID: ' + JSON.stringify(soterResult.data)
                }).toPromise();
            }
        } catch (e) {
            this.logger.error(e.message);

            if (e.status === 400) {
                await this.telegram.sendMessage({
                    chat_id: '-330731984',
                    text: 'Error: ' + e.response.body.data
                }).toPromise();
                this.logger.error(e.response.body.data);
            }
        }
    }
}
