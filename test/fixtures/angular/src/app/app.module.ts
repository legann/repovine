import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: '', redirectTo: 'users', pathMatch: 'full' },
      { path: 'users', loadChildren: () => import('./users/users.module').then(m => m.UsersModule) },
    ]),
  ],
})
export class AppModule {}
