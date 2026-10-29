import {CourseService} from '../../desktop/src/core/course-service';
import {migrationClient,type MigrationScheduling} from './migration-api';
export class DevelopmentCourseService extends CourseService {
 readonly migration=migrationClient((action,payload)=>this.request(action,payload));
 constructor(workerPath:string,options?:ConstructorParameters<typeof CourseService>[1]&{migrationScheduling?:MigrationScheduling}){super(workerPath,options);}
}
// Existing developer fixture scripts load the service beside their selected worker.
export {DevelopmentCourseService as CourseService};
